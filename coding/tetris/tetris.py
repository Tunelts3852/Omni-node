import pygame, random, sys

pygame.init()

CELL = 30
COLS, ROWS = 10, 20
SIDE = COLS * CELL
HEIGHT = ROWS * CELL
TOP = 60
WIDTH = SIDE + 200
FPS = 60

WHITE = (255,255,255)
GRAY  = (128,128,128)
BLACK = (  0,  0,  0)
COLORS = [
    (  0,255,255), (  0,  0,255), (255,165,  0),
    (255,255,  0), (  0,255,  0), (128,  0,128),
    (255,  0,  0)
]
SHAPES = [
    [[1,1,1,1]],
    [[1,1],[1,1]],
    [[0,1,0],[1,1,1]],
    [[1,1,0],[0,1,1]],
    [[0,1,1],[1,1,0]],
    [[1,0,0],[1,1,1]],
    [[0,0,1],[1,1,1]]
]

class Tetris:
    def __init__(self):
        self.screen = pygame.display.set_mode((WIDTH, HEIGHT + TOP))
        pygame.display.set_caption("테트리스")
        self.clock = pygame.time.Clock()
        self.grid = [[0]*COLS for _ in range(ROWS)]
        self.current = self.new_piece()
        self.next = self.new_piece()
        self.game_over = False
        self.drop_timer = 0
        self.speed = 500

    def new_piece(self):
        idx = random.randint(0, len(SHAPES)-1)
        return {
            'shape': SHAPES[idx],
            'color': COLORS[idx],
            'x': COLS//2 - len(SHAPES[idx][0])//2,
            'y': 0
        }

    def valid(self, piece, dx=0, dy=0):
        for y, row in enumerate(piece['shape']):
            for x, val in enumerate(row):
                if val:
                    nx = piece['x'] + x + dx
                    ny = piece['y'] + y + dy
                    if nx < 0 or nx >= COLS or ny >= ROWS:
                        return False
                    if ny >= 0 and self.grid[ny][nx]:
                        return False
        return True

    def lock(self):
        for y, row in enumerate(self.current['shape']):
            for x, val in enumerate(row):
                if val:
                    ny = self.current['y'] + y
                    nx = self.current['x'] + x
                    if ny >= 0:
                        self.grid[ny][nx] = self.current['color']
        self.clear_lines()
        self.current = self.next
        self.next = self.new_piece()
        if not self.valid(self.current):
            self.game_over = True

    def clear_lines(self):
        new_grid = [row for row in self.grid if any(c == 0 for c in row)]
        lines = ROWS - len(new_grid)
        for _ in range(lines):
            new_grid.insert(0, [0]*COLS)
        self.grid = new_grid

    def rotate(self):
        old = self.current['shape']
        self.current['shape'] = [list(row) for row in zip(*old[::-1])]
        if not self.valid(self.current):
            self.current['shape'] = old

    def draw(self):
        self.screen.fill(BLACK)
        # 그리드
        for y in range(ROWS):
            for x in range(COLS):
                color = self.grid[y][x] or GRAY
                pygame.draw.rect(self.screen, color, (x*CELL, TOP+y*CELL, CELL, CELL), 0)
                pygame.draw.rect(self.screen, BLACK, (x*CELL, TOP+y*CELL, CELL, CELL), 1)
        # 현재 조각
        for y, row in enumerate(self.current['shape']):
            for x, val in enumerate(row):
                if val:
                    px = (self.current['x'] + x) * CELL
                    py = TOP + (self.current['y'] + y) * CELL
                    pygame.draw.rect(self.screen, self.current['color'], (px, py, CELL, CELL), 0)
                    pygame.draw.rect(self.screen, BLACK, (px, py, CELL, CELL), 1)
        # 다음 조각
        font = pygame.font.SysFont(None, 24)
        txt = font.render("Next", True, WHITE)
        self.screen.blit(txt, (SIDE+20, 30))
        for y, row in enumerate(self.next['shape']):
            for x, val in enumerate(row):
                if val:
                    pygame.draw.rect(self.screen, self.next['color'],
                                     (SIDE+20+x*CELL, 60+y*CELL, CELL, CELL), 0)
                    pygame.draw.rect(self.screen, BLACK,
                                     (SIDE+20+x*CELL, 60+y*CELL, CELL, CELL), 1)
        if self.game_over:
            txt = font.render("GAME OVER", True, WHITE)
            self.screen.blit(txt, (WIDTH//2-60, HEIGHT//2))
        pygame.display.flip()

    def run(self):
        while True:
            dt = self.clock.tick(FPS)
            self.drop_timer += dt
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    pygame.quit(); return
                if event.type == pygame.KEYDOWN and not self.game_over:
                    if event.key == pygame.K_LEFT and self.valid(self.current, dx=-1):
                        self.current['x'] -= 1
                    elif event.key == pygame.K_RIGHT and self.valid(self.current, dx=1):
                        self.current['x'] += 1
                    elif event.key == pygame.K_DOWN and self.valid(self.current, dy=1):
                        self.current['y'] += 1
                    elif event.key == pygame.K_UP:
                        self.rotate()
                    elif event.key == pygame.K_SPACE:
                        while self.valid(self.current, dy=1):
                            self.current['y'] += 1
                        self.lock()
            if self.drop_timer > self.speed and not self.game_over:
                self.drop_timer = 0
                if self.valid(self.current, dy=1):
                    self.current['y'] += 1
                else:
                    self.lock()
            self.draw()

if __name__ == "__main__":
    Tetris().run()