"""Builds questions.csv from src/base.csv and the src/band_*.py batches.

Run: python3 questions/build.py
"""
import collections
import csv
import importlib.util
import pathlib
import sys

HERE = pathlib.Path(__file__).parent
SRC = HERE / 'src'
TOPICS = {'G': 'General knowledge', 'S': 'Science & nature', 'Y': 'Geography',
          'H': 'History', 'M': 'Sport, music & film'}
HEADER = ['topic', 'age', 'grade', 'question', 'answer', 'wrong1', 'wrong2', 'wrong3']

rows = list(csv.reader(open(SRC / 'base.csv', encoding='utf-8')))[1:]
for path in sorted(SRC.glob('band_*.py')):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    for topic, grade, *rest in mod.Q:
        rows.append([TOPICS[topic], mod.BAND, str(grade), *rest])

problems = []
seen = set()
for r in rows:
    if len(r) != 8:
        problems.append(f'wrong column count: {r}')
        continue
    topic, band, grade, question, *options = r
    if len(set(options)) != 4:
        problems.append(f'options not distinct: {question}')
    if grade not in '12345':
        problems.append(f'bad grade {grade}: {question}')
    if 'which of these' in question.lower():
        problems.append(f'needs the choices to make sense: {question}')
    key = (band, question.lower())
    if key in seen:
        problems.append(f'duplicate in band {band}: {question}')
    seen.add(key)

counts = collections.Counter((r[1], r[2]) for r in rows)
bands = sorted({r[1] for r in rows}, key=lambda b: (b == 'adult', int(b.split('-')[0]) if b[0].isdigit() else 0))
for band in bands:
    print(f'{band:>6}: ' + '  '.join(f'g{g}={counts[(band, str(g))]:>3}' for g in range(1, 6)))
print(f'total: {len(rows)}')

if problems:
    print('\n'.join(problems))
    sys.exit(1)

with open(HERE / 'questions.csv', 'w', encoding='utf-8', newline='') as f:
    w = csv.writer(f, lineterminator='\n')
    w.writerow(HEADER)
    w.writerows(rows)
