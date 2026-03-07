import tkinter as tk
from tkinter import filedialog
import pygame
import os

class MP3Player:
    def __init__(self, root):
        self.root = root
        self.root.title("Python MP3 Player")
        self.root.geometry("300x150")
        pygame.mixer.init()
        
        self.btn_load = tk.Button(root, text="파일 선택", command=self.load_file)
        self.btn_load.pack(pady=10)
        self.btn_play = tk.Button(root, text="재생", command=self.play_music)
        self.btn_play.pack()
        self.btn_stop = tk.Button(root, text="정지", command=self.stop_music)
        self.btn_stop.pack()
        
        self.file_path = None

    def load_file(self):
        self.file_path = filedialog.askopenfilename(filetypes=[("MP3 Files", "*.mp3")])

    def play_music(self):
        if self.file_path and os.path.exists(self.file_path):
            pygame.mixer.music.load(self.file_path)
            pygame.mixer.music.play()

    def stop_music(self):
        pygame.mixer.music.stop()

if __name__ == "__main__":
    root = tk.Tk()
    app = MP3Player(root)
    root.mainloop()