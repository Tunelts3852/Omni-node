#define _GNU_SOURCE
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

#define LOCK_PATH_TEMPLATE "/tmp/omninode.%u.lock"
#define SOCKET_PATH_TEMPLATE "/tmp/omninode_core.%u.sock"
#define MAX_CLIENTS 64
#define IO_BUFFER_SIZE 4096

static volatile sig_atomic_t g_should_stop = 0;
static int g_lock_fd = -1;
static char g_lock_path[108] = {0};
static char g_socket_path[108] = {0};

static void on_signal(int signo) {
    (void)signo;
    g_should_stop = 1;
}

static int set_nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0) {
        return -1;
    }

    if (fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) {
        return -1;
    }

    return 0;
}

static int acquire_single_instance_lock(void) {
    const uid_t uid = getuid();
    int flags = O_RDWR | O_CREAT | O_EXCL;
#ifdef O_CLOEXEC
    flags |= O_CLOEXEC;
#endif
#ifdef O_NOFOLLOW
    flags |= O_NOFOLLOW;
#endif

    snprintf(g_lock_path, sizeof(g_lock_path), LOCK_PATH_TEMPLATE, (unsigned int)uid);

    int fd = open(g_lock_path, flags, 0600);
    if (fd < 0 && errno == EEXIST) {
        int open_flags = O_RDWR;
#ifdef O_CLOEXEC
        open_flags |= O_CLOEXEC;
#endif
#ifdef O_NOFOLLOW
        open_flags |= O_NOFOLLOW;
#endif
        fd = open(g_lock_path, open_flags, 0600);
    }

    if (fd < 0) {
        perror("failed to open lock file");
        return -1;
    }

    struct stat st;
    if (fstat(fd, &st) != 0) {
        perror("fstat(lock)");
        close(fd);
        return -1;
    }

    if (!S_ISREG(st.st_mode)) {
        fprintf(stderr, "lock path is not a regular file: %s\n", g_lock_path);
        close(fd);
        return -1;
    }

    if (fchmod(fd, S_IRUSR | S_IWUSR) != 0) {
        perror("fchmod(lock)");
    }

    if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
        if (errno == EWOULDBLOCK || errno == EAGAIN) {
            fprintf(stderr, "omninode_core is already running (lock: %s)\n", g_lock_path);
        } else {
            perror("flock(lock)");
        }
        close(fd);
        return -1;
    }

    if (ftruncate(fd, 0) == 0) {
        dprintf(fd, "%ld\n", (long)getpid());
    }

    g_lock_fd = fd;
    return 0;
}

static int setup_server_socket(const char *path) {
    int server_fd = socket(AF_UNIX, SOCK_STREAM, 0);
    struct sockaddr_un addr;

    if (server_fd < 0) {
        perror("socket");
        return -1;
    }

    if (set_nonblocking(server_fd) != 0) {
        perror("fcntl");
        close(server_fd);
        return -1;
    }

    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);

    mode_t previous_umask = umask(0077);
    unlink(path);
    if (bind(server_fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        umask(previous_umask);
        perror("bind");
        close(server_fd);
        return -1;
    }
    umask(previous_umask);

    if (chmod(path, 0600) != 0) {
        perror("chmod");
    }

    if (listen(server_fd, 64) != 0) {
        perror("listen");
        close(server_fd);
        unlink(path);
        return -1;
    }

    return server_fd;
}

static bool validate_peer_uid(int client_fd) {
#if defined(__linux__)
    struct ucred cred;
    socklen_t len = sizeof(cred);
    if (getsockopt(client_fd, SOL_SOCKET, SO_PEERCRED, &cred, &len) != 0) {
        perror("getsockopt(SO_PEERCRED)");
        return false;
    }

    return cred.uid == getuid();
#elif defined(__APPLE__)
    uid_t peer_uid = (uid_t)-1;
    gid_t peer_gid = (gid_t)-1;
    if (getpeereid(client_fd, &peer_uid, &peer_gid) != 0) {
        perror("getpeereid");
        return false;
    }

    (void)peer_gid;
    return peer_uid == getuid();
#else
    return true;
#endif
}

static bool extract_json_string(const char *json, const char *key, char *out, size_t out_len) {
    char pattern[128];
    const char *p = NULL;
    size_t i = 0;

    if (out_len == 0) {
        return false;
    }

    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    p = strstr(json, pattern);
    if (p == NULL) {
        return false;
    }

    p = strchr(p, ':');
    if (p == NULL) {
        return false;
    }
    p++;

    while (*p != '\0' && isspace((unsigned char)*p)) {
        p++;
    }

    if (*p != '"') {
        return false;
    }
    p++;

    while (*p != '\0' && *p != '"' && i + 1 < out_len) {
        if (*p == '\\' && p[1] != '\0') {
            p++;
        }
        out[i++] = *p++;
    }

    out[i] = '\0';
    return *p == '"';
}

static bool extract_json_int64(const char *json, const char *key, long long *value) {
    char pattern[128];
    const char *p = NULL;
    char *endptr = NULL;

    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    p = strstr(json, pattern);
    if (p == NULL) {
        return false;
    }

    p = strchr(p, ':');
    if (p == NULL) {
        return false;
    }
    p++;

    while (*p != '\0' && isspace((unsigned char)*p)) {
        p++;
    }

    errno = 0;
    *value = strtoll(p, &endptr, 10);
    if (errno != 0 || endptr == p) {
        return false;
    }

    return true;
}

static long get_mem_free_mb(void) {
#if defined(_SC_AVPHYS_PAGES)
    long pages = sysconf(_SC_AVPHYS_PAGES);
#elif defined(_SC_PHYS_PAGES)
    long pages = sysconf(_SC_PHYS_PAGES);
#else
    long pages = -1;
#endif
    long page_size = sysconf(_SC_PAGESIZE);

    if (pages <= 0 || page_size <= 0) {
        return -1;
    }

    return (long)(((double)pages * (double)page_size) / (1024.0 * 1024.0));
}

static double get_cpu_load_1m(void) {
    double loadavg[3] = {0.0, 0.0, 0.0};
    if (getloadavg(loadavg, 1) == 1) {
        return loadavg[0];
    }
    return -1.0;
}

static void build_error_response(char *out, size_t out_len, const char *message) {
    snprintf(out, out_len, "{\"status\":\"error\",\"message\":\"%s\"}", message);
}

static void handle_request(const char *request, char *response, size_t response_len) {
    char action[64] = {0};

    if (!extract_json_string(request, "action", action, sizeof(action))) {
        build_error_response(response, response_len, "missing action");
        return;
    }

    if (strcmp(action, "get_metrics") == 0) {
        double cpu_load = get_cpu_load_1m();
        long mem_free_mb = get_mem_free_mb();
        snprintf(
            response,
            response_len,
            "{\"status\":\"ok\",\"cpu_usage\":%.2f,\"mem_free_mb\":%ld}",
            cpu_load,
            mem_free_mb
        );
        return;
    }

    if (strcmp(action, "kill") == 0) {
        long long pid = 0;
        if (!extract_json_int64(request, "pid", &pid)) {
            build_error_response(response, response_len, "missing pid");
            return;
        }
        if (pid <= 1) {
            build_error_response(response, response_len, "invalid pid");
            return;
        }
        if (kill((pid_t)pid, SIGTERM) != 0) {
            char error_msg[128];
            snprintf(error_msg, sizeof(error_msg), "kill failed: %s", strerror(errno));
            build_error_response(response, response_len, error_msg);
            return;
        }

        snprintf(response, response_len, "{\"status\":\"ok\",\"killed_pid\":%lld}", pid);
        return;
    }

    build_error_response(response, response_len, "unknown action");
}

static void close_client(struct pollfd *entry) {
    if (entry->fd >= 0) {
        close(entry->fd);
        entry->fd = -1;
        entry->events = 0;
        entry->revents = 0;
    }
}

static bool register_client(struct pollfd *clients, int client_fd) {
    for (int i = 1; i < MAX_CLIENTS + 1; ++i) {
        if (clients[i].fd < 0) {
            clients[i].fd = client_fd;
            clients[i].events = POLLIN;
            clients[i].revents = 0;
            return true;
        }
    }

    return false;
}

int main(void) {
    int server_fd = -1;
    struct pollfd poll_fds[MAX_CLIENTS + 1];
    const uid_t uid = getuid();

    if (acquire_single_instance_lock() != 0) {
        return 1;
    }

    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

    snprintf(g_socket_path, sizeof(g_socket_path), SOCKET_PATH_TEMPLATE, (unsigned int)uid);
    server_fd = setup_server_socket(g_socket_path);
    if (server_fd < 0) {
        if (g_lock_fd >= 0) {
            close(g_lock_fd);
        }
        return 1;
    }

    for (int i = 0; i < MAX_CLIENTS + 1; ++i) {
        poll_fds[i].fd = -1;
        poll_fds[i].events = 0;
        poll_fds[i].revents = 0;
    }

    poll_fds[0].fd = server_fd;
    poll_fds[0].events = POLLIN;

    fprintf(stderr, "omninode_core started (uid=%u, uds=%s, lock=%s)\n", (unsigned int)uid, g_socket_path, g_lock_path);

    while (!g_should_stop) {
        int ready = poll(poll_fds, MAX_CLIENTS + 1, 500);
        if (ready < 0) {
            if (errno == EINTR) {
                continue;
            }
            perror("poll");
            break;
        }

        if (ready == 0) {
            continue;
        }

        if ((poll_fds[0].revents & POLLIN) != 0) {
            while (true) {
                int client_fd = accept(server_fd, NULL, NULL);
                if (client_fd < 0) {
                    if (errno == EAGAIN || errno == EWOULDBLOCK) {
                        break;
                    }
                    perror("accept");
                    break;
                }

                if (set_nonblocking(client_fd) != 0) {
                    perror("fcntl(client)");
                    close(client_fd);
                    continue;
                }

                if (!validate_peer_uid(client_fd)) {
                    fprintf(stderr, "rejected client: uid mismatch\n");
                    close(client_fd);
                    continue;
                }

                if (!register_client(poll_fds, client_fd)) {
                    const char *busy_msg = "{\"status\":\"error\",\"message\":\"server busy\"}\n";
                    send(client_fd, busy_msg, strlen(busy_msg), 0);
                    close(client_fd);
                }
            }
        }

        for (int i = 1; i < MAX_CLIENTS + 1; ++i) {
            struct pollfd *entry = &poll_fds[i];
            char input[IO_BUFFER_SIZE];
            char output[IO_BUFFER_SIZE];

            if (entry->fd < 0) {
                continue;
            }

            if ((entry->revents & (POLLERR | POLLHUP | POLLNVAL)) != 0) {
                close_client(entry);
                continue;
            }

            if ((entry->revents & POLLIN) == 0) {
                continue;
            }

            ssize_t n = recv(entry->fd, input, sizeof(input) - 1, 0);
            if (n <= 0) {
                close_client(entry);
                continue;
            }

            input[n] = '\0';
            memset(output, 0, sizeof(output));
            handle_request(input, output, sizeof(output));
            send(entry->fd, output, strlen(output), 0);
            send(entry->fd, "\n", 1, 0);
            close_client(entry);
        }
    }

    for (int i = 1; i < MAX_CLIENTS + 1; ++i) {
        close_client(&poll_fds[i]);
    }

    close(server_fd);
    unlink(g_socket_path);

    if (g_lock_fd >= 0) {
        close(g_lock_fd);
    }

    fprintf(stderr, "omninode_core stopped\n");
    return 0;
}
