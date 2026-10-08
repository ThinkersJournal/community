# PROVES: C8 real-corpus measurement (2026-10-08-c8-real-corpus-measurement.md, Method): builds the corpus of benign free-licensed Commons images (CC0, public domain, CC BY, CC BY-SA, up to 3 MB, at most 8 per category over 12 categories, with a title blocklist) and the manifest. The five title exclusions in the write-up were made outside this script.
# INPUTS: argv[1] = OUTDIR (must already exist); env SPIKE_CONTACT (required, a contact string for the Wikimedia User-Agent; the script fails with KeyError if unset). Runs on the host. Network access to Wikimedia Commons only: the API at commons.wikimedia.org plus the image URLs the API returns.
# EFFECTS: downloads images into OUTDIR (1 s pause per file, 4 retries on failure) and OVERWRITES manifest.tsv in OUTDIR's parent directory (OUTDIR/../manifest.tsv). No docker, no strace.
# BENIGN: host-side, network read-only against Wikimedia Commons, writes only under OUTDIR and the manifest.tsv beside it; it issues no docker, wsl or host-level kill/stop/prune command.
# ARCHIVED: preserved from the spike session; only the User-Agent contact value was changed to come from SPIKE_CONTACT.
# usage: fetch.py OUTDIR  -- queries Commons per category, downloads benign free-licensed images, writes manifest.tsv
import sys, os, json, re, time, urllib.request, urllib.parse
OUT = sys.argv[1]
UA = {'User-Agent': 'tj-spike-c8/1.0 (measurement; contact ' + os.environ['SPIKE_CONTACT'] + ')'}
API = 'https://commons.wikimedia.org/w/api.php'
CATS = {
 'ui_screenshot': ['screenshot GNOME settings', 'screenshot KDE Plasma dialog', 'screenshot Firefox preferences', 'screenshot LibreOffice Writer'],
 'web_screenshot': ['screenshot website homepage', 'screenshot Wikipedia mobile page', 'screenshot web browser page'],
 'terminal_code': ['screenshot terminal bash', 'screenshot source code editor', 'screenshot vim'],
 'chart_graph': ['bar chart', 'line graph statistics', 'pie chart', 'scatter plot'],
 'diagram': ['flowchart', 'architecture diagram', 'UML diagram', 'network diagram'],
 'map': ['locator map', 'blank map', 'road map'],
 'slide': ['presentation slide', 'powerpoint slide'],
 'meme_text': ['text on flat background', 'poster typography', 'infographic'],
 'logo_icon': ['logo svg icon', 'icon flat', 'logo'],
 'pixel_art': ['pixel art', 'sprite 8-bit'],
 'line_art_cartoon': ['line art', 'cartoon drawing', 'comic strip'],
 'document_scan': ['scanned document', 'scan of page text', 'letter manuscript scan'],
}
BAD = re.compile(r'nude|sex|porn|erotic|naked|bikini|fetish|gore|corpse|dead|child|boy|girl|baby|kid|school|person|portrait|face|woman|man ', re.I)
OKLIC = re.compile(r'^(CC0|Public domain|PD|CC BY(?!-NC|-ND)|CC-BY(?!-NC|-ND)|CC BY-SA|CC-BY-SA)', re.I)
def get(u):
    for i in range(4):
        try:
            return urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=60).read()
        except Exception as e:
            time.sleep(3*(i+1)); err = e
    raise err
man = open(os.path.join(OUT, '..', 'manifest.tsv'), 'w', encoding='utf-8')
man.write('file\tcategory\tlicence\tauthor\turl\ttitle\n')
n = 0; seen = set()
for cat, qs in CATS.items():
    got = 0
    for q in qs:
        if got >= 8: break
        for ft in ('bitmap',):
            p = {'action':'query','format':'json','generator':'search','gsrsearch':f'{q} filetype:{ft}','gsrnamespace':'6','gsrlimit':'40',
                 'prop':'imageinfo','iiprop':'url|size|mime|extmetadata'}
            d = json.loads(get(API+'?'+urllib.parse.urlencode(p)))
            pages = sorted(d.get('query',{}).get('pages',{}).values(), key=lambda x: x.get('index',0))
            for pg in pages:
                if got >= 8: break
                ii = pg.get('imageinfo',[{}])[0]
                mime = ii.get('mime',''); t = pg['title']
                if mime not in ('image/png','image/jpeg','image/gif','image/webp') or t in seen: continue
                if BAD.search(t) or ii.get('size',0) > 3_000_000: continue
                em = ii.get('extmetadata',{})
                lic = em.get('LicenseShortName',{}).get('value','')
                if not OKLIC.match(lic): continue
                au = re.sub(r'<[^>]+>','',em.get('Artist',{}).get('value','?')).replace('\t',' ').replace('\n',' ')[:80]
                seen.add(t)
                ext = {'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp'}[mime]
                fn = f'{cat}_{got:02d}.{ext}'
                try: data = get(ii['url'])
                except Exception as e: print('skip', t, e); continue
                open(os.path.join(OUT, fn),'wb').write(data)
                man.write(f'{fn}\t{cat}\t{lic}\t{au}\t{ii.get("descriptionurl")}\t{t}\n'); man.flush()
                got += 1; n += 1; time.sleep(1)
    print(cat, got, flush=True)
print('total', n)
