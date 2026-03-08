from __future__ import annotations

import math
from pathlib import Path
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from typing import List, Optional

import pygame

SUPPORTED_EXTENSIONS = {".mp3"}
TICK_MS = 500


class MP3PlayerApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("Python MP3 Player")
        self.root.geometry("900x560")
        self.root.minsize(760, 460)
        self.root.configure(bg="#111827")

        self.playlist: List[Path] = []
        self.current_index: Optional[int] = None
        self.drag_index: Optional[int] = None
        self.is_paused = False
        self.user_dragging_progress = False
        self.track_length = 0.0
        self.volume = 0.7

        pygame.mixer.init()
        pygame.mixer.music.set_volume(self.volume)

        self.status_var = tk.StringVar(value="파일을 추가하세요")
        self.now_playing_var = tk.StringVar(value="선택된 곡 없음")
        self.time_var = tk.StringVar(value="00:00 / 00:00")
        self.volume_var = tk.DoubleVar(value=self.volume * 100)
        self.progress_var = tk.DoubleVar(value=0)

        self._build_styles()
        self._build_ui()
        self._bind_events()
        self._schedule_tick()

    def _build_styles(self) -> None:
        style = ttk.Style()
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass

        style.configure("Root.TFrame", background="#111827")
        style.configure("Card.TFrame", background="#1f2937")
        style.configure("Title.TLabel", background="#111827", foreground="#f9fafb", font=("Helvetica", 24, "bold"))
        style.configure("Muted.TLabel", background="#111827", foreground="#9ca3af", font=("Helvetica", 11))
        style.configure("CardTitle.TLabel", background="#1f2937", foreground="#f9fafb", font=("Helvetica", 14, "bold"))
        style.configure("CardText.TLabel", background="#1f2937", foreground="#d1d5db", font=("Helvetica", 11))
        style.configure("Action.TButton", font=("Helvetica", 11, "bold"), padding=(12, 8), background="#2563eb", foreground="#ffffff")
        style.map("Action.TButton", background=[("active", "#1d4ed8")])
        style.configure("Ghost.TButton", font=("Helvetica", 10), padding=(10, 8), background="#374151", foreground="#ffffff")
        style.map("Ghost.TButton", background=[("active", "#4b5563")])
        style.configure("Player.Horizontal.TScale", background="#1f2937", troughcolor="#374151")

    def _build_ui(self) -> None:
        root_frame = ttk.Frame(self.root, style="Root.TFrame", padding=20)
        root_frame.pack(fill="both", expand=True)
        root_frame.columnconfigure(0, weight=2)
        root_frame.columnconfigure(1, weight=3)
        root_frame.rowconfigure(1, weight=1)

        header = ttk.Frame(root_frame, style="Root.TFrame")
        header.grid(row=0, column=0, columnspan=2, sticky="ew", pady=(0, 16))
        header.columnconfigure(0, weight=1)

        ttk.Label(header, text="Python MP3 Player", style="Title.TLabel").grid(row=0, column=0, sticky="w")
        ttk.Label(header, text="Tkinter UI와 pygame 오디오 재생 기반", style="Muted.TLabel").grid(row=1, column=0, sticky="w", pady=(4, 0))

        left_card = ttk.Frame(root_frame, style="Card.TFrame", padding=16)
        left_card.grid(row=1, column=0, sticky="nsew", padx=(0, 12))
        left_card.rowconfigure(2, weight=1)
        left_card.columnconfigure(0, weight=1)

        ttk.Label(left_card, text="재생목록", style="CardTitle.TLabel").grid(row=0, column=0, sticky="w")

        list_actions = ttk.Frame(left_card, style="Card.TFrame")
        list_actions.grid(row=1, column=0, sticky="ew", pady=(12, 12))
        for idx in range(4):
            list_actions.columnconfigure(idx, weight=1)

        ttk.Button(list_actions, text="파일 추가", style="Action.TButton", command=self.add_files).grid(row=0, column=0, sticky="ew", padx=(0, 6))
        ttk.Button(list_actions, text="폴더 추가", style="Ghost.TButton", command=self.add_folder).grid(row=0, column=1, sticky="ew", padx=6)
        ttk.Button(list_actions, text="선택 삭제", style="Ghost.TButton", command=self.remove_selected).grid(row=0, column=2, sticky="ew", padx=6)
        ttk.Button(list_actions, text="목록 비우기", style="Ghost.TButton", command=self.clear_playlist).grid(row=0, column=3, sticky="ew", padx=(6, 0))

        playlist_frame = ttk.Frame(left_card, style="Card.TFrame")
        playlist_frame.grid(row=2, column=0, sticky="nsew")
        playlist_frame.rowconfigure(0, weight=1)
        playlist_frame.columnconfigure(0, weight=1)

        self.playlist_box = tk.Listbox(
            playlist_frame,
            activestyle="none",
            bg="#111827",
            fg="#f9fafb",
            selectbackground="#2563eb",
            selectforeground="#ffffff",
            highlightthickness=0,
            relief="flat",
            font=("Helvetica", 12),
            exportselection=False,
        )
        self.playlist_box.grid(row=0, column=0, sticky="nsew")

        scrollbar = ttk.Scrollbar(playlist_frame, orient="vertical", command=self.playlist_box.yview)
        scrollbar.grid(row=0, column=1, sticky="ns")
        self.playlist_box.configure(yscrollcommand=scrollbar.set)

        right_card = ttk.Frame(root_frame, style="Card.TFrame", padding=20)
        right_card.grid(row=1, column=1, sticky="nsew")
        right_card.columnconfigure(0, weight=1)
        right_card.rowconfigure(4, weight=1)

        ttk.Label(right_card, text="현재 재생", style="CardTitle.TLabel").grid(row=0, column=0, sticky="w")
        ttk.Label(right_card, textvariable=self.now_playing_var, style="CardText.TLabel", wraplength=420).grid(row=1, column=0, sticky="ew", pady=(12, 4))
        ttk.Label(right_card, textvariable=self.status_var, style="CardText.TLabel").grid(row=2, column=0, sticky="w", pady=(0, 18))

        self.progress_scale = ttk.Scale(
            right_card,
            from_=0,
            to=100,
            orient="horizontal",
            variable=self.progress_var,
            style="Player.Horizontal.TScale",
            command=self._on_progress_changed,
        )
        self.progress_scale.grid(row=3, column=0, sticky="ew")

        time_row = ttk.Frame(right_card, style="Card.TFrame")
        time_row.grid(row=4, column=0, sticky="new", pady=(8, 0))
        time_row.columnconfigure(0, weight=1)
        ttk.Label(time_row, textvariable=self.time_var, style="CardText.TLabel").grid(row=0, column=0, sticky="w")

        controls = ttk.Frame(right_card, style="Card.TFrame")
        controls.grid(row=5, column=0, sticky="ew", pady=(28, 16))
        for idx in range(5):
            controls.columnconfigure(idx, weight=1)

        ttk.Button(controls, text="이전곡", style="Ghost.TButton", command=self.play_previous).grid(row=0, column=0, sticky="ew", padx=(0, 6))
        ttk.Button(controls, text="재생", style="Action.TButton", command=self.play_selected).grid(row=0, column=1, sticky="ew", padx=6)
        ttk.Button(controls, text="일시정지", style="Ghost.TButton", command=self.toggle_pause).grid(row=0, column=2, sticky="ew", padx=6)
        ttk.Button(controls, text="정지", style="Ghost.TButton", command=self.stop).grid(row=0, column=3, sticky="ew", padx=6)
        ttk.Button(controls, text="다음곡", style="Ghost.TButton", command=self.play_next).grid(row=0, column=4, sticky="ew", padx=(6, 0))

        volume_row = ttk.Frame(right_card, style="Card.TFrame")
        volume_row.grid(row=6, column=0, sticky="ew")
        volume_row.columnconfigure(1, weight=1)
        ttk.Label(volume_row, text="볼륨", style="CardText.TLabel").grid(row=0, column=0, sticky="w", padx=(0, 12))

        self.volume_scale = ttk.Scale(
            volume_row,
            from_=0,
            to=100,
            orient="horizontal",
            variable=self.volume_var,
            style="Player.Horizontal.TScale",
            command=self._on_volume_changed,
        )
        self.volume_scale.grid(row=0, column=1, sticky="ew")

    def _bind_events(self) -> None:
        self.playlist_box.bind("<Double-Button-1>", lambda _event: self.play_selected())
        self.playlist_box.bind("<<ListboxSelect>>", self._on_select)
        self.playlist_box.bind("<ButtonPress-1>", self._on_drag_start)
        self.playlist_box.bind("<ButtonRelease-1>", self._on_drag_drop)
        self.progress_scale.bind("<ButtonPress-1>", self._on_progress_press)
        self.progress_scale.bind("<ButtonRelease-1>", self._on_progress_release)
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

    def add_files(self) -> None:
        paths = filedialog.askopenfilenames(
            title="MP3 파일 선택",
            filetypes=[("MP3 파일", "*.mp3")],
        )
        self._append_paths(Path(path) for path in paths)

    def add_folder(self) -> None:
        folder = filedialog.askdirectory(title="MP3 폴더 선택")
        if not folder:
            return
        files = sorted(
            path for path in Path(folder).iterdir() if path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS
        )
        self._append_paths(files)

    def _append_paths(self, paths) -> None:
        new_items = [path for path in paths if path.suffix.lower() in SUPPORTED_EXTENSIONS and path not in self.playlist]
        if not new_items:
            self.status_var.set("추가할 새 MP3 파일이 없습니다")
            return

        self.playlist.extend(new_items)
        for path in new_items:
            self.playlist_box.insert(tk.END, path.name)

        self.status_var.set(f"{len(new_items)}개 파일을 추가했습니다")
        if self.current_index is None and self.playlist:
            self._select_index(0)

    def remove_selected(self) -> None:
        selection = self.playlist_box.curselection()
        if not selection:
            self.status_var.set("삭제할 곡을 선택하세요")
            return

        index = selection[0]
        removed_current = index == self.current_index
        del self.playlist[index]
        self.playlist_box.delete(index)

        if self.current_index is not None:
            if index < self.current_index:
                self.current_index -= 1
            elif removed_current:
                self.stop(reset_selection=False)
                if self.playlist:
                    self._select_index(min(index, len(self.playlist) - 1))
                else:
                    self.current_index = None
                    self.now_playing_var.set("선택된 곡 없음")

        self.status_var.set("선택한 곡을 삭제했습니다")

    def clear_playlist(self) -> None:
        self.stop(reset_selection=False)
        self.playlist.clear()
        self.playlist_box.delete(0, tk.END)
        self.current_index = None
        self.now_playing_var.set("선택된 곡 없음")
        self.status_var.set("재생목록을 비웠습니다")
        self._update_progress(0, 0)

    def play_selected(self) -> None:
        if not self.playlist:
            messagebox.showinfo("재생목록 비어 있음", "먼저 MP3 파일을 추가하세요.")
            return

        selection = self.playlist_box.curselection()
        index = selection[0] if selection else self.current_index
        if index is None:
            index = 0

        self._play_index(index)

    def _play_index(self, index: int, start_pos: float = 0.0) -> None:
        if index < 0 or index >= len(self.playlist):
            return

        path = self.playlist[index]
        try:
            pygame.mixer.music.load(path.as_posix())
            pygame.mixer.music.play(start=max(0.0, start_pos))
        except pygame.error as exc:
            self.status_var.set("재생 실패")
            messagebox.showerror("재생 오류", f"파일을 재생할 수 없습니다.\n{exc}")
            return

        self.current_index = index
        self.is_paused = False
        self.track_length = self._get_track_length(path)
        self.now_playing_var.set(path.name)
        self.status_var.set("재생 중")
        self._select_index(index)
        self._update_progress(start_pos, self.track_length)

    def toggle_pause(self) -> None:
        if self.current_index is None:
            self.status_var.set("먼저 곡을 재생하세요")
            return

        if self.is_paused:
            pygame.mixer.music.unpause()
            self.is_paused = False
            self.status_var.set("재생 중")
        else:
            if not pygame.mixer.music.get_busy() and self.progress_var.get() <= 0:
                self.play_selected()
                return
            pygame.mixer.music.pause()
            self.is_paused = True
            self.status_var.set("일시정지")

    def stop(self, reset_selection: bool = True) -> None:
        pygame.mixer.music.stop()
        self.is_paused = False
        self.status_var.set("정지")
        self._update_progress(0, self.track_length)
        if reset_selection and self.current_index is not None:
            self._select_index(self.current_index)

    def play_next(self) -> None:
        if not self.playlist:
            return
        if self.current_index is None:
            self._play_index(0)
            return
        next_index = (self.current_index + 1) % len(self.playlist)
        self._play_index(next_index)

    def play_previous(self) -> None:
        if not self.playlist:
            return
        if self.current_index is None:
            self._play_index(0)
            return
        previous_index = (self.current_index - 1) % len(self.playlist)
        self._play_index(previous_index)

    def _on_select(self, _event=None) -> None:
        selection = self.playlist_box.curselection()
        if not selection:
            return
        index = selection[0]
        if 0 <= index < len(self.playlist):
            self.now_playing_var.set(self.playlist[index].name)

    def _on_drag_start(self, event) -> None:
        self.drag_index = self.playlist_box.nearest(event.y)

    def _on_drag_drop(self, event) -> None:
        if self.drag_index is None:
            return
        drop_index = self.playlist_box.nearest(event.y)
        if drop_index == self.drag_index or drop_index < 0:
            self.drag_index = None
            return

        item = self.playlist.pop(self.drag_index)
        self.playlist.insert(drop_index, item)
        label = self.playlist_box.get(self.drag_index)
        self.playlist_box.delete(self.drag_index)
        self.playlist_box.insert(drop_index, label)
        self._select_index(drop_index)

        if self.current_index == self.drag_index:
            self.current_index = drop_index
        elif self.current_index is not None:
            if self.drag_index < self.current_index <= drop_index:
                self.current_index -= 1
            elif drop_index <= self.current_index < self.drag_index:
                self.current_index += 1

        self.drag_index = None
        self.status_var.set("재생목록 순서를 변경했습니다")

    def _on_volume_changed(self, _value: str) -> None:
        self.volume = self.volume_var.get() / 100
        pygame.mixer.music.set_volume(self.volume)

    def _on_progress_press(self, _event) -> None:
        self.user_dragging_progress = True

    def _on_progress_release(self, _event) -> None:
        self.user_dragging_progress = False
        self._seek_to_progress()

    def _on_progress_changed(self, _value: str) -> None:
        if self.user_dragging_progress and self.track_length > 0:
            current_seconds = (self.progress_var.get() / 100) * self.track_length
            self.time_var.set(f"{self._format_time(current_seconds)} / {self._format_time(self.track_length)}")

    def _seek_to_progress(self) -> None:
        if self.current_index is None or self.track_length <= 0:
            return
        seconds = (self.progress_var.get() / 100) * self.track_length
        self._play_index(self.current_index, start_pos=seconds)

    def _schedule_tick(self) -> None:
        self._poll_player_state()
        self.root.after(TICK_MS, self._schedule_tick)

    def _poll_player_state(self) -> None:
        if self.current_index is None:
            return

        if not self.user_dragging_progress:
            current_seconds = 0.0
            if pygame.mixer.music.get_busy():
                current_seconds = max(0.0, pygame.mixer.music.get_pos() / 1000)
            elif not self.is_paused and self.track_length > 0 and self.progress_var.get() >= 99:
                self.play_next()
                return

            self._update_progress(current_seconds, self.track_length)

    def _update_progress(self, current_seconds: float, total_seconds: float) -> None:
        if total_seconds > 0:
            ratio = max(0.0, min(100.0, (current_seconds / total_seconds) * 100))
        else:
            ratio = 0.0
        self.progress_var.set(ratio)
        self.time_var.set(f"{self._format_time(current_seconds)} / {self._format_time(total_seconds)}")

    def _select_index(self, index: int) -> None:
        self.playlist_box.selection_clear(0, tk.END)
        self.playlist_box.selection_set(index)
        self.playlist_box.activate(index)
        self.playlist_box.see(index)

    def _get_track_length(self, path: Path) -> float:
        try:
            sound = pygame.mixer.Sound(path.as_posix())
            return float(sound.get_length())
        except pygame.error:
            return 0.0

    @staticmethod
    def _format_time(seconds: float) -> str:
        seconds = max(0, int(math.floor(seconds)))
        minutes, secs = divmod(seconds, 60)
        return f"{minutes:02d}:{secs:02d}"

    def _on_close(self) -> None:
        pygame.mixer.music.stop()
        pygame.mixer.quit()
        self.root.destroy()


def main() -> None:
    root = tk.Tk()
    app = MP3PlayerApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
