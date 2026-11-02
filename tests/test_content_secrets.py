import base64,importlib.util,json,unittest
from pathlib import Path
from nacl.public import PrivateKey,SealedBox
from nacl.exceptions import CryptoError
spec=importlib.util.spec_from_file_location('content_secrets',Path(__file__).parents[1]/'scripts/content-secrets.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class SecretCopyTests(unittest.TestCase):
    def setUp(self):
        self.key=PrivateKey.generate();self.recipient={'schema':1,'repository':'StefanZhang/blog-publisher','environment':'content-auto','key_id':'123','key':base64.b64encode(bytes(self.key.public_key)).decode()}
        self.values={n:'synthetic-only-'+n for n in m.NAMES}
    def test_only_recipient_can_decrypt_and_no_plaintext_in_artifact(self):
        result=m.encrypt(self.recipient,self.values);serialized=json.dumps(result)
        for name,value in self.values.items():
            self.assertNotIn(value,serialized);encrypted=base64.b64decode(result['values'][name]);self.assertEqual(SealedBox(self.key).decrypt(encrypted).decode(),value)
            with self.assertRaises(CryptoError):SealedBox(PrivateKey.generate()).decrypt(encrypted)
        self.assertNotEqual(result['values'],m.encrypt(self.recipient,self.values)['values'])
    def test_wrong_recipient_missing_or_extra_values_fail(self):
        for patch in [{'repository':'other/repo'},{'environment':'production'},{'key_id':'bad'},{'key':base64.b64encode(b'short').decode()}]:
            with self.assertRaises(ValueError):m.encrypt({**self.recipient,**patch},self.values)
        for values in [{},{**self.values,'OTHER':'x'},{**self.values,m.NAMES[0]:''}]:
            with self.assertRaises(ValueError):m.encrypt(self.recipient,values)
if __name__=='__main__':unittest.main()
