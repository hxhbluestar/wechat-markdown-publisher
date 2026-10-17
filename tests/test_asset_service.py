import base64
import io
from pathlib import Path
import sys
import tempfile
import unittest
from PIL import Image
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'app/web'))
from editor_service import DraftStore
from asset_service import inventory,derive_asset

class AssetServiceTests(unittest.TestCase):
 def test_derivative_retains_original_and_reports_references_and_relations(self):
  with tempfile.TemporaryDirectory() as directory:
   store=DraftStore(Path(directory)/'drafts');d=store.create('# A\n\n![原图说明](images/original.png)\n\n![再次引用](images/original.png)')
   out=io.BytesIO();Image.new('RGB',(120,80),(20,40,80)).save(out,'PNG');original=out.getvalue()
   store.save_asset(d['id'],'images/original.png',base64.b64encode(original).decode())
   result=derive_asset(store,d['id'],'images/original.png','cover',{'ratio':2.35,'focal_point':[.5,.5]})
   self.assertNotEqual(result['asset']['path'],'images/original.png')
   self.assertEqual(store.asset_path(d['id'],'images/original.png').read_bytes(),original)
   self.assertEqual(store.get(d['id'])['content'],d['content'])
   items=inventory(store,d['id']);source=next(a for a in items if a['path']=='images/original.png')
   self.assertEqual(source['reference_count'],2);self.assertEqual(source['width'],120)
   target=next(a for a in items if a['path']==result['asset']['path']);self.assertEqual(target['derivation']['source_path'],'images/original.png')
if __name__=='__main__':unittest.main()
