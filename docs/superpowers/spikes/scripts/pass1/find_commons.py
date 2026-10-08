# PROVES: Section 3 'Fixtures': searches the Wikimedia Commons API for candidate files and prints title, URL, size, licence and categories as JSON, the input that download.py uses to pick CC0 photos. Inferred from the code; the write-up does not name this script.
# INPUTS: argv[1:] = Commons search queries. Network access to commons.wikimedia.org (w/api.php) only. The write-up does not say whether it ran in the container.
# EFFECTS: network reads only; prints one JSON array to stdout; writes no files. Sends User-Agent 'tj-spike/1.0 (fixture research; contact via repo owner)'.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway container you created yourself with a unique name such as tjspike1-* (never touch other containers).
# ARCHIVED: preserved verbatim from the spike session.
import json, sys, urllib.request, urllib.parse
UA={'User-Agent':'tj-spike/1.0 (fixture research; contact via repo owner)'}
def api(**p):
    p['format']='json'
    u='https://commons.wikimedia.org/w/api.php?'+urllib.parse.urlencode(p)
    return json.load(urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=60))
out=[]
for q in sys.argv[1:]:
    r=api(action='query',generator='search',gsrsearch=q,gsrnamespace=6,gsrlimit=30,prop='imageinfo',iiprop='url|size|mime|extmetadata')
    for pg in (r.get('query',{}).get('pages',{}) or {}).values():
        ii=pg['imageinfo'][0]; m=ii['extmetadata']
        out.append(dict(title=pg['title'],url=ii['url'],w=ii['width'],h=ii['height'],mime=ii['mime'],size=ii['size'],lic=m.get('LicenseShortName',{}).get('value'),cat=m.get('Categories',{}).get('value','')[:200],q=q))
json.dump(out,sys.stdout,indent=0)
