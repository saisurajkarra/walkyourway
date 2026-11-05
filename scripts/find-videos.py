#!/usr/bin/env python3
"""Find and verify real first-person walking videos for WalkYourWay video walks.

  python3 scripts/find-videos.py search "Times Square to Central Park walking tour 4K"
  python3 scripts/find-videos.py verify jnhs74j9kRE

`verify` confirms the video exists, can be embedded in other sites, and prints its title,
channel and length. Only verified IDs may go into src/data/videos/*.json.
"""
import json, re, subprocess, sys, urllib.parse

UA = ['-A', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', '-H', 'Accept-Language: en-US']


def get(url):
    return subprocess.run(['curl', '-s', '-m', '30', *UA, url], capture_output=True, text=True, errors='ignore').stdout


def results(q):
    h = get('https://www.youtube.com/results?search_query=' + urllib.parse.quote_plus(q))
    m = re.search(r'var ytInitialData = (\{.*?\});</script>', h)
    out = []
    if not m:
        return out
    def walk(o):
        if isinstance(o, dict):
            if 'videoRenderer' in o:
                v = o['videoRenderer']
                out.append((v.get('videoId'), v.get('lengthText', {}).get('simpleText', '?'),
                            ''.join(r['text'] for r in v.get('ownerText', {}).get('runs', [])),
                            ''.join(r['text'] for r in v.get('title', {}).get('runs', []))))
            for x in o.values(): walk(x)
        elif isinstance(o, list):
            for x in o: walk(x)
    walk(json.loads(m.group(1)))
    return out


def search(q):
    for vid, length, ch, title in results(q)[:12]:
        print(f'{vid}  {length:>8}  {ch[:24]:<24}  {title}')


def secs(t):
    n = 0
    for part in t.split(':'):
        n = n * 60 + int(part)
    return n


def verify(vid):
    """oEmbed only answers 200 for public videos that allow embedding on other sites."""
    r = subprocess.run(['curl', '-s', '-m', '20', '-w', '\n%{http_code}',
                        f'https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={vid}&format=json'],
                       capture_output=True, text=True).stdout.rsplit('\n', 1)
    code, meta = r[-1], {}
    if code == '200':
        meta = json.loads(r[0])
    length = next((l for v, l, _, _ in results(vid) if v == vid and l != '?'), None)
    print(json.dumps({'youtubeId': vid, 'ok': code == '200' and bool(length), 'embeddable': code == '200',
                      'durationSec': secs(length) if length else None,
                      'title': meta.get('title'), 'channel': meta.get('author_name')}, ensure_ascii=False))


if __name__ == '__main__':
    cmd, arg = sys.argv[1], ' '.join(sys.argv[2:])
    search(arg) if cmd == 'search' else verify(arg)
