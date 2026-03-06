   #!/usr/bin/env bash
   set -euo pipefail
   mkdir -p tetris
   cat > tetris/requirements.txt <<'REQ'
   pygame>=2.0.0
   REQ
   cat > tetris/tetris.py <<'PY'
   #!/usr/bin/env python3
   import sys
   import subprocess
   import time
   try:
       import pygame
   except Exception:
       subprocess.check_call([sys.executable, "-m", "pip", "install", "--user", "pygame>=2.0.0"])
       time.sleep(0.5)
       import pygame

   import random

   # Tetris configuration
   CELL_SIZE = 30
   COLS = 10
   ROWS = 20
   WIDTH = CELL_SIZE * COLS
   HEIGHT = CELL_SIZE * ROWS
   FPS = 60
   FALL_EVENT = pygame.USEREVENT + 1

   # Colors
   BLACK = (0, 0, 0)
   GRAY = (50, 50, 50)
   WHITE = (255, 255, 255)
   COLORS = [
       (0, 240, 240),  # I
       (0, 0, 240),    # J
       (240, 160, 0),  # L
       (240, 240, 0),  # O
       (0, 240, 0),    # S
       (160, 0, 240),  # T
       (240, 0, 0),    # Z
   ]

   # Tetromino shapes (4x4 matrices)
   SHAPES = [
       [[0,0,0,0],
        [1,1,1,1],
        [0,0,0,0],
        [0,0,0,0]],  # I
       [[2,0,0],
        [2,2,2],
        [0,0,0]],    # J
       [[0,0,3],
        [3,3,3],
        [0,0,0]],    # L
       [[4,4],
        [4,4]],      # O
       [[0,5,5],
        [5,5,0],
        [0,0,0]],    # S
       [[0,6,0],
        [6,6,6],
        [0,0,0]],    # T
       [[7,7,0],
        [0,7,7],
        [0,0,0]],    # Z
   ]

   def rotate(shape):
       return [list(row) for row in zip(*shape[::-1])]

   class Piece:
       def __init__(self, shape_idx):
           self.shape_idx = shape_idx
           self.shape = [row[:] for row in SHAPES[shape_idx]]
           self.color = COLORS[shape_idx]
           self.x = COLS // 2 - len(self.shape[0]) // 2
           self.y = 0

       def rotate(self):
           new_shape = rotate(self.shape)
           return new_shape

   class Game:
       def __init__(self):
           pygame.init()
           pygame.display.set_caption("Tetris")
           self.screen = pygame.display.set_mode((WIDTH, HEIGHT))
           self.clock = pygame.time.Clock()
           self.grid = [[0 for _ in range(COLS)] for _ in range(ROWS)]
           self.score = 0
           self.level = 1
           self.lines = 0
           self.current = self.new_piece()
           self.next = self.new_piece()
           self.drop_interval = 700  # ms
           pygame.time.set_timer(FALL_EVENT, self.drop_interval)
           self.game_over = False
           self.paused = False

       def new_piece(self):
           return Piece(random.randrange(len(SHAPES)))

       def valid(self, shape, offset_x, offset_y):
           for r, row in enumerate(shape):
               for c, val in enumerate(row):
                   if val:
                       x = offset_x + c
                       y = offset_y + r
                       if x < 0 or x >= COLS or y >= ROWS:
                           return False
                       if y >= 0 and self.grid[y][x]:
                           return False
           return True

       def lock_piece(self):
           for r, row in enumerate(self.current.shape):
               for c, val in enumerate(row):
                   if val:
                       x = self.current.x + c
                       y = self.current.y + r
                       if 0 <= y < ROWS and 0 <= x < COLS:
                           self.grid[y][x] = self.current.shape_idx + 1
                       else:
                           self.game_over = True
           self.clear_lines()
           self.current = self.next
           self.next = self.new_piece()
           if not self.valid(self.current.shape, self.current.x, self.current.y):
               self.game_over = True

       def clear_lines(self):
           new_grid = []
           lines_cleared = 0
           for row in self.grid:
               if all(row):
                   lines_cleared += 1
               else:
                   new_grid.append(row)
           for _ in range(lines_cleared):
               new_grid.insert(0, [0 for _ in range(COLS)])
           self.grid = new_grid
           if lines_cleared:
               self.lines += lines_cleared
               self.score += (100 * (2 ** (lines_cleared - 1))) * self.level
               if self.lines // 10 + 1 > self.level:
                   self.level += 1
                   self.drop_interval = max(100, int(self.drop_interval * 0.8))
                   pygame.time.set_timer(FALL_EVENT, self.drop_interval)

       def hard_drop(self):
           while self.valid(self.current.shape, self.current.x, self.current.y + 1):
               self.current.y += 1
           self.lock_piece()

       def move(self, dx):
           if self.valid(self.current.shape, self.current.x + dx, self.current.y):
               self.current.x += dx

       def soft_drop(self):
           if self.valid(self.current.shape, self.current.x, self.current.y + 1):
               self.current.y += 1
           else:
               self.lock_piece()

       def rotate_current(self):
           new_shape = self.current.rotate()
           # Try kicks
           for kick in [0, -1, 1, -2, 2]:
               if self.valid(new_shape, self.current.x + kick, self.current.y):
                   self.current.shape = new_shape
                   self.current.x += kick
                   return

       def draw_grid(self):
           for y in range(ROWS):
               for x in range(COLS):
                   rect = pygame.Rect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE)
                   val = self.grid[y][x]
                   if val:
                       color = COLORS[val - 1]
                       pygame.draw.rect(self.screen, color, rect.inflate(-2, -2))
                   else:
                       pygame.draw.rect(self.screen, BLACK, rect)
                   pygame.draw.rect(self.screen, GRAY, rect, 1)

       def draw_piece(self, piece, offset_x=0, offset_y=0):
           for r, row in enumerate(piece.shape):
               for c, val in enumerate(row):
                   if val:
                       x = (piece.x + c + offset_x) * CELL_SIZE
                       y = (piece.y + r + offset_y) * CELL_SIZE
                       rect = pygame.Rect(x, y, CELL_SIZE, CELL_SIZE)
                       pygame.draw.rect(self.screen, piece.color, rect.inflate(-2, -2))
                       pygame.draw.rect(self.screen, WHITE, rect, 1)

       def draw_next(self):
           # small preview at top-left
           preview_x = WIDTH - 120
           preview_y = 20
           s = 24
           for r, row in enumerate(self.next.shape):
               for c, val in enumerate(row):
                   if val:
                       rect = pygame.Rect(preview_x + c * s, preview_y + r * s, s, s)
                       color = self.next.color
                       pygame.draw.rect(self.screen, color, rect.inflate(-2, -2))
                       pygame.draw.rect(self.screen, WHITE, rect, 1)
           # draw score
           font = pygame.font.SysFont("Arial", 20)
           score_surf = font.render(f"Score: {self.score}", True, WHITE)
           lvl_surf = font.render(f"Level: {self.level}", True, WHITE)
           lines_surf = font.render(f"Lines: {self.lines}", True, WHITE)
           self.screen.blit(score_surf, (WIDTH - 120, preview_y + 90))
           self.screen.blit(lvl_surf, (WIDTH - 120, preview_y + 115))
           self.screen.blit(lines_surf, (WIDTH - 120, preview_y + 140))

       def run(self):
           while True:
               self.clock.tick(FPS)
               for event in pygame.event.get():
                   if event.type == pygame.QUIT:
                       pygame.quit()
                       sys.exit(0)
                   if event.type == pygame.KEYDOWN:
                       if event.key == pygame.K_ESCAPE:
                           pygame.quit()
                           sys.exit(0)
                       if event.key == pygame.K_p:
                           self.paused = not self.paused
                       if not self.paused and not self.game_over:
                           if event.key == pygame.K_LEFT:
                               self.move(-1)
                           elif event.key == pygame.K_RIGHT:
                               self.move(1)
                           elif event.key == pygame.K_DOWN:
                               self.soft_drop()
                           elif event.key == pygame.K_UP:
                               self.rotate_current()
                           elif event.key == pygame.K_SPACE:
                               self.hard_drop()
                   if event.type == FALL_EVENT and not self.paused and not self.game_over:
                       if self.valid(self.current.shape, self.current.x, self.current.y + 1):
                           self.current.y += 1
                       else:
                           self.lock_piece()

               self.screen.fill((10, 10, 10))
               self.draw_grid()
               if not self.game_over:
                   self.draw_piece(self.current)
               else:
                   font = pygame.font.SysFont("Arial", 48)
                   surf = font.render("GAME OVER", True, (200, 30, 30))
                   self.screen.blit(surf, ((WIDTH - surf.get_width()) // 2, HEIGHT // 2 - 50))
                   font2 = pygame.font.SysFont("Arial", 24)
                   surf2 = font2.render(f"Score: {self.score}  Lines: {self.lines}", True, WHITE)
                   self.screen.blit(surf2, ((WIDTH - surf2.get_width()) // 2, HEIGHT // 2 + 10))

               self.draw_next()
               pygame.display.flip()

   if __name__ == "__main__":
       try:
           Game().run()
       except Exception as e:
           print("Error:", e)
           raise
   PY
   # Install dependencies (best effort), check syntax, then run the game
   python3 -m pip install --user -r tetris/requirements.txt --quiet || true
   python3 -m py_compile tetris/tetris.py
   python3 tetris/tetris.py