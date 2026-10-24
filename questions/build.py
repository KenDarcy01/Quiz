"""Builds questions.csv from src/base.csv and the src/band_*.py batches.

Also writes questions.json, the same questions for the Supabase import (supabase/import_questions.sql).

Run: python3 questions/build.py
"""
import collections
import csv
import importlib.util
import json
import pathlib
import random
import sys

HERE = pathlib.Path(__file__).parent
SRC = HERE / 'src'
TOPICS = {'G': 'General knowledge', 'S': 'Science & nature', 'Y': 'Geography',
          'H': 'History', 'M': 'Sport, music & film',
          'N': 'Maths & numbers'}
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

# Picture questions (database only; the one-phone game sticks to text). The stored question is a
# unique label; players see the prompt from media.
pictures = []
spec = importlib.util.spec_from_file_location('flags', SRC / 'flags.py')
flags = importlib.util.module_from_spec(spec)
spec.loader.exec_module(flags)
countries = {c['code']: c for c in json.load(open(HERE / 'flag_countries.json', encoding='utf-8'))}
tier_of = {code: g for g, codes in flags.TIERS.items() for code in codes.split()}
name_of = {code: flags.NAMES.get(code, countries[code]['name']) for code in tier_of}
rng = random.Random(7)  # the same wrong choices on every build
for n, (code, grade) in enumerate(tier_of.items()):
    if not (HERE.parent / 'media' / 'flags' / f'{code}.svg').exists():
        problems.append(f'missing flag image: {code}')
    near = [c for c in tier_of if c != code and countries[c]['continent'] == countries[code]['continent']
            and abs(tier_of[c] - grade) <= 1]
    if len(near) < 3:
        near = [c for c in tier_of if c != code and abs(tier_of[c] - grade) <= 1]
    pictures.append({'topic': flags.TOPIC, 'age': '', 'grade': grade, 'question': f'Flag: {code}',
                     'answer': name_of[code], 'wrong': [name_of[c] for c in rng.sample(near, 3)],
                     'kind': 'picture', 'media_url': f'media/flags/{code}.svg',
                     'media': {'reveal': 'zoom' if n % 2 else 'blur', 'prompt': flags.PROMPT}})
spec = importlib.util.spec_from_file_location('hum', SRC / 'hum.py')
hum = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hum)
for grade, songs in hum.SONGS.items():
    for title, by in songs:
        pictures.append({'topic': hum.TOPIC, 'age': '', 'grade': grade, 'question': f'Hum: {title}',
                         'answer': title, 'wrong': [], 'kind': 'music', 'media_url': None,
                         'media': {'mode': 'hum', 'prompt': hum.PROMPT, 'by': by}})
print(f'pictures and hum-it: {len(pictures)}')
if problems:
    print('\n'.join(problems))
    sys.exit(1)

# One question per line, so diffs stay readable.
with open(HERE / 'questions.json', 'w', encoding='utf-8') as f:
    f.write('[\n' + ',\n'.join(
        [json.dumps({'topic': t, 'age': a, 'grade': int(g), 'question': q, 'answer': ans, 'wrong': w},
                    ensure_ascii=False)
         for t, a, g, q, ans, *w in rows]
        + [json.dumps(p, ensure_ascii=False) for p in pictures]) + '\n]\n')
