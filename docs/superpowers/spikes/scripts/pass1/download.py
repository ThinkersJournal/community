# PROVES: Section 3 'Fixtures' (27 real CC0 photos from Wikimedia Commons): fetches p01-p06 as original files and p07+ as Commons thumbnails of width min(original, 3840), with retries (the write-up cites HTTP 429 rate limits), and records a manifest. Inferred from the code; the write-up does not name this script.
# INPUTS: argv[1] = file of wanted Commons titles (one per line, without the File: prefix); argv[2:] = candidate JSON files (the output of find_commons.py). Network access to Wikimedia Commons: Special:FilePath, plus the original-file URLs stored in the candidate JSON. Writes under the /fix mount; the write-up does not say whether it ran in the container.
# EFFECTS: downloads over the network (up to 6 tries each, sleeps of 20 s x attempt on failure, 3 s between files); writes /fix/orig/pNN.jpg and /fix/manifest_photos.json; asserts the licence is CC0 or Public domain; sends User-Agent 'tj-spike/1.0 (fixture research)'.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway container you created yourself with a unique name such as tjspike1-* (never touch other containers). The script has no kill or stop of its own; the write-up (section 6 item 9) records that a stuck downloader was once stopped with a broad docker kill that also stopped other containers, so stop only your own named container.
# ARCHIVED: preserved verbatim from the spike session.
import json, sys, urllib.request, urllib.parse, hashlib, time, os
cands=[]
for f in sys.argv[2:]: cands+=json.load(open(f))
want=[l.strip() for l in open(sys.argv[1]) if l.strip()]
out='/fix/orig'; os.makedirs(out,exist_ok=True)
man=[]
for t in want:
    m=[c for c in cands if c['title']=='File:'+t]
    assert len(m)==1,(t,len(m))
    c=m[0]; assert c['lic'] in('CC0','Public domain'),c
    fn=f"p{len(man)+1:02d}.jpg"
    data=None
    if os.path.exists(f'{out}/'+f"p{len(man)+1:02d}.jpg"):
        data=open(f'{out}/'+f"p{len(man)+1:02d}.jpg",'rb').read()
    for a in range(6 if data is None else 0):
        try:
            url=c['url'] if len(man)<6 else 'https://commons.wikimedia.org/wiki/Special:FilePath/'+urllib.parse.quote(t)+'?width='+str(min(c['w'],3840))
            req=urllib.request.Request(url,headers={'User-Agent':'tj-spike/1.0 (fixture research)'})
            data=urllib.request.urlopen(req,timeout=120).read(); break
        except Exception as e:
            print('retry',t,e,flush=True); time.sleep(20*(a+1))
    if data is None: print('GIVEUP',t,flush=True); man.append(None); continue
    open(f'{out}/{fn}','wb').write(data)
    man.append(dict(file=fn,title=c['title'],url=c['url'],fetched_via=('original' if len(man)<6 else 'commons thumbnail width=%d'%min(c['w'],3840)),licence=c['lic'],bytes=len(data),sha256=hashlib.sha256(data).hexdigest(),w=c['w'],h=c['h']))
    print(fn,t,len(data),flush=True); time.sleep(3)
man=[m for m in man if m]
json.dump(man,open('/fix/manifest_photos.json','w'),indent=1)
