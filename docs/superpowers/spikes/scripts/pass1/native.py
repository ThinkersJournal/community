# PROVES: Stage A, section 4c 'Small images (both sides <= 512)': hashing the native-size frame (no resize) against the reference for the d_small*, e_o*_400x300 and d_anim* fixtures (write-up: d = 0 on all 12 such fixtures).
# INPUTS: no arguments. Container mounts seen in the scripts: /fix = fixtures, /s = the scripts directory, /o = output. Globs /fix/set/d_small*, /fix/set/e_o*_400x300.jpg, /fix/set/d_anim*; needs magick and pdqtool on PATH.
# EFFECTS: writes /tmp/n.raw (overwritten per file) and prints one line per fixture. No network, no strace/ptrace.
# BENIGN: it issues no docker, wsl or host-level kill/stop/prune command; run only inside a throwaway container you created yourself with a unique name such as tjspike1-* (never touch other containers).
# ARCHIVED: preserved verbatim from the spike session.
import subprocess,sys,os,glob
def ham(a,b): return bin(int(a,16)^int(b,16)).count('1')
for f in sorted(glob.glob('/fix/set/d_small*')+glob.glob('/fix/set/e_o*_400x300.jpg')+glob.glob('/fix/set/d_anim*')):
    d=open(f,'rb').read(); fmt={b'\xff\xd8':'jpeg',b'\x89P':'png',b'GI':'gif',b'RI':'webp'}[d[:2]]
    sel='[0]' if fmt in('gif','webp') else ''
    w,h=map(int,subprocess.run(['magick','identify','-format','%w %h',f'{fmt}:-[0]'],input=d,capture_output=True).stdout.split())
    raw=subprocess.run(['magick',f'{fmt}:-{sel}','-colorspace','sRGB','-alpha','off','-depth','8','rgb:-'],input=d,capture_output=True).stdout
    open('/tmp/n.raw','wb').write(raw)
    hn,qn=subprocess.run(['pdqtool','raw','/tmp/n.raw',str(w),str(h)],capture_output=True,text=True).stdout.split()
    hr,qr,_=subprocess.run(['pdqtool','file',f],capture_output=True,text=True).stdout.split()
    print(os.path.basename(f),w,h,'native-frame d=',ham(hr,hn),'q',qn)
