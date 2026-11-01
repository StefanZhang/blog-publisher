"""Extract data only; never trust artifact paths, permissions or reported sizes."""
import pathlib,stat,zipfile,sys
ROOTS={'site','reports','release.json','source-files.json','legacy-urls.json','query-urls.json','edge-query-rules.json','verified-local.json'}
def unpack(archive,directory):
    root=pathlib.Path(directory)
    root.mkdir(exist_ok=False,parents=False)
    seen=set();total=0
    with zipfile.ZipFile(archive) as z:
        items=z.infolist()
        if len(items)>12000: raise ValueError('Too many ZIP entries')
        for item in items:
            p=pathlib.PurePosixPath(item.filename)
            if p.is_absolute() or '..' in p.parts or '\\' in item.filename or not p.parts or p.parts[0] not in ROOTS or str(p) in seen: raise ValueError('Unsafe/duplicate ZIP path')
            seen.add(str(p))
            mode=item.external_attr>>16
            if stat.S_ISLNK(mode) or stat.S_IFMT(mode) not in (0,stat.S_IFREG,stat.S_IFDIR): raise ValueError('Nonregular ZIP entry')
            total+=item.file_size
            if total>450*1024*1024 or item.file_size>30*1024*1024: raise ValueError('Oversized ZIP')
            target=root.joinpath(*p.parts)
            if item.is_dir(): target.mkdir(parents=True,exist_ok=True);continue
            target.parent.mkdir(parents=True,exist_ok=True)
            received=0
            with z.open(item) as src, target.open('xb') as out:
                while True:
                    block=src.read(65536)
                    if not block:break
                    received+=len(block)
                    if received>item.file_size:raise ValueError('ZIP size mismatch')
                    out.write(block)
            if received!=item.file_size:raise ValueError('Truncated ZIP')
if __name__=='__main__':unpack(sys.argv[1],sys.argv[2])
