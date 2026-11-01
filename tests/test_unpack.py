import unittest,tempfile,pathlib,zipfile,sys,stat
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
from unpack import unpack
class ArchiveTests(unittest.TestCase):
 def extract(self,names):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);z=root/'x.zip'
   with zipfile.ZipFile(z,'w') as f:
    for name in names:f.writestr(name,'data')
   unpack(z,root/'out')
 def test_regular(self): self.extract(['site/index.html','release.json','reports/build.log'])
 def test_paths(self):
  for name in ['../escape','/absolute','site/../../escape','site/\\escape','unexpected/file']:
   with self.subTest(name=name),self.assertRaises(ValueError):self.extract([name])
 def test_duplicate(self):
  with self.assertRaises(ValueError):self.extract(['site/index.html','site/index.html'])
 def test_symlink(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);z=root/'x.zip';info=zipfile.ZipInfo('site/link');info.create_system=3;info.external_attr=(stat.S_IFLNK|0o777)<<16
   with zipfile.ZipFile(z,'w')as f:f.writestr(info,'/etc/passwd')
   with self.assertRaises(ValueError):unpack(z,root/'out')
