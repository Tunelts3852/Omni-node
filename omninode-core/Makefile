CC ?= cc
CFLAGS ?= -std=c11 -Wall -Wextra -O2
TARGET := omninode_core
SRC := src/main.c

.PHONY: all clean run

all: $(TARGET)

$(TARGET): $(SRC)
	$(CC) $(CFLAGS) -o $@ $(SRC)

run: $(TARGET)
	./$(TARGET)

clean:
	rm -f $(TARGET)

