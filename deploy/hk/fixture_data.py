"""Public synthetic routes only. Contains no copied site content or historical URL lists."""
import hashlib
from routing import CANONICAL,PUBLICATION,HEADERS_SHA

def synthetic_fixture():
    names=['index.html','404.html','articles/one/index.html','articles/two/index.html','notes/index.html','about/index.html','category/example/index.html','category/example/2/index.html','tag/mixed/index.html','tag/mixed/2/index.html','images/uploads/demo.png','images/opt/demo.webp','_astro/demo.css','og/demo.png','rss.xml','feed.json','search-index.json','sitemap-index.xml']
    files={name:{'bytes':7,'sha256':hashlib.sha256(b'fixture').hexdigest()} for name in names}
    routing={
        'redirects':[
            {'source':'/legacy','target':'/articles/one/','status':301},
            {'source':'/category/example/page/1/','target':'/category/example/','status':301},
            {'source':'/category/:slug/page/:page/','target':'/category/:slug/:page/','status':301},
            {'source':'/tag/:slug/page/1/','target':'/tag/:slug/','status':301},
            {'source':'/tag/:slug/page/:page/','target':'/tag/:slug/:page/','status':301},
            {'source':'/notes-old/*','target':'/notes/','status':301},
            {'source':'/author/*','target':'/about/','status':301},
            {'source':'/wp-sitemap-*','target':'/sitemap-index.xml','status':301},
            {'source':'/rss','target':'/rss.xml','status':301},
        ],
        'attachments':[{'path':'/media/示例图片','target':'/images/uploads/demo.png'}],
        'queries':[
            {'parameter':'p','value':'101','target':'/articles/one/','status':301},
            {'parameter':'page_id','value':'202','target':'/about/','status':301},
            {'parameter':'attachment_id','value':'303','target':'/images/uploads/demo.png','status':301},
        ]
    }
    pairs=[('/','/'),('/legacy','/articles/one/'),('/legacy?keep=1','/articles/one/'),
           ('/category/example/page/1/','/category/example/'),('/category/example/page/2/','/category/example/2/'),
           ('/tag/mixed/page/1/','/tag/mixed/'),('/tag/mixed/page/2/','/tag/mixed/2/'),
           ('/notes-old/a/b','/notes/'),('/author/any/','/about/'),('/wp-sitemap-posts-1.xml','/sitemap-index.xml'),
           ('/rss?keep=1','/rss.xml'),('/media/示例图片/','/images/uploads/demo.png'),
           ('/media/%e7%a4%ba%e4%be%8b%e5%9b%be%e7%89%87','/images/uploads/demo.png'),
           ('/?p=101','/articles/one/'),('/?%70=%31%30%31','/articles/one/'),
           ('/?p=101&page_id=202&attachment_id=303','/articles/one/'),('/?attachment_id=303','/images/uploads/demo.png'),
           ('/?p=bad&p=101','/?p=bad&p=101'),('/?p=&p=101&page_id=202','/about/'),
           ('/?x=a&p=101&x=b','/articles/one/'),('/?attachment_id=303&p=101','/articles/one/'),
           ('/?%70=bad&p=101&page_id=202','/about/'),('/?p=bad&page_id=202&attachment_id=303','/about/')]
    return {'schema':1,'canonicalOrigin':CANONICAL,'publicationOrigin':PUBLICATION,'headersSHA256':HEADERS_SHA,'files':files,'routing':routing},[{'url':u,'target':t} for u,t in pairs]+[{'url':'/category/example/page/99/','target':'/category/example/99/','status':404,'reason':'Deliberately absent synthetic page; redirect must preserve its 404.'}]
