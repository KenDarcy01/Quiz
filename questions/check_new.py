"""Checks new question files for repeats before building.

Compares every question in the given src files with every other question in the bank (all bands and
topics), and with each other. Reports exact repeats (same wording once case and punctuation are
ignored) and near repeats (very similar wording, or same answer with mostly the same words).

Run: python3 questions/check_new.py questions/src/band_8_9_b7.py [more files...]
Exit code 1 if anything is found, so remove or rewrite the flagged questions and run it again.
"""
import csv
import difflib
import importlib.util
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).parent
SRC = HERE / 'src'
STOP = set('a an the of in is was what which who whom whose how many much does did do to and or for on at by with from that this it its are be called name'.split())


def norm(s):
    return re.sub(r'[^\w ]', '', s.lower().replace('-', ' ').replace('_', ' ')).split()


def load(path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    out = []
    for row in mod.Q:
        _, grade, q, ans, *w = row  # (topic or band, grade, question, answer, wrongs...)
        out.append((q, ans, w))
    return out


new_paths = [pathlib.Path(p).resolve() for p in sys.argv[1:]]
bank = []  # (source, question, answer)
for r in list(csv.reader(open(SRC / 'base.csv', encoding='utf-8')))[1:]:
    bank.append(('base.csv', r[3], r[4]))
for path in sorted(SRC.glob('*.py')):
    if path.resolve() in new_paths or not path.stem.startswith(('band_', 'topic_')):
        continue
    for q, a, _ in load(path):
        bank.append((path.name, q, a))

index = {}
for src, q, a in bank:
    index.setdefault(' '.join(norm(q)), (src, q))
bank_keys = [(set(norm(q)) - STOP, ' '.join(norm(q)), norm(a), src, q) for src, q, a in bank]

found = 0
seen_new = {}
for path in new_paths:
    for q, a, w in load(path):
        key = ' '.join(norm(q))
        hit = index.get(key) or seen_new.get(key)
        if hit:
            print(f'{path.name}: EXACT  "{q}"  <- {hit[0]}')
            found += 1
            continue
        words = set(norm(q)) - STOP
        na = norm(a)
        for bw, bkey, ba, src, bq in bank_keys:
            if not words or not bw:
                continue
            overlap = len(words & bw) / min(len(words), len(bw))
            if overlap < 0.5:
                continue
            if (na == ba and overlap >= 0.6) or difflib.SequenceMatcher(None, key, bkey).ratio() > 0.88:
                print(f'{path.name}: NEAR   "{q}" [{a}]  ~ "{bq}" [{" ".join(ba)}] ({src})')
                found += 1
                break
        seen_new[key] = (path.name, q)
        bank_keys.append((words, key, na, path.name, q))
print(f'{found} possible repeats')
sys.exit(1 if found else 0)
