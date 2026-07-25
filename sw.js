// Sinator Vitals — minimální service worker
// Stará se hlavně o splnění podmínek pro instalaci PWA a jednoduché offline
// zobrazení posledně navštívené stránky. Data appky se ukládají do localStorage,
// ne sem — tohle jen cachuje statický shell (HTML/manifest/ikony).

var CACHE_NAME = 'sinator-vitals-v2';
var SHELL_URLS = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){
      return cache.addAll(SHELL_URLS).catch(function(){ /* ignore chybějící soubory */ });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k!==CACHE_NAME; }).map(function(k){ return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

self.addEventListener('notificationclick', function(event){
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({type:'window', includeUncontrolled:true}).then(function(clientList){
      for(var i=0;i<clientList.length;i++){
        var c = clientList[i];
        if('focus' in c) return c.focus();
      }
      if(self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});

self.addEventListener('fetch', function(event){
  if(event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request).then(function(res){
      var resClone = res.clone();
      caches.open(CACHE_NAME).then(function(cache){ cache.put(event.request, resClone); }).catch(function(){});
      return res;
    }).catch(function(){
      return caches.match(event.request).then(function(cached){
        return cached || caches.match('/index.html');
      });
    })
  );
});
