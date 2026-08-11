export const SERVICE_WORKER_SOURCE = `
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('push',event=>{
  let data={title:'Spendwatch',body:'Capacity update',url:'/',tag:'spendwatch'};
  try{if(event.data)data={...data,...event.data.json()}}catch{}
  event.waitUntil(self.registration.showNotification(data.title,{
    body:data.body,tag:data.tag,data:{url:data.url||'/'},renotify:false,
    icon:data.icon||'/android-icon-192x192.png',badge:data.badge||'/favicon-96x96.png',
    requireInteraction:Boolean(data.requireInteraction)
  }));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const target=new URL(event.notification.data?.url||'/',self.location.origin).href;
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(clients=>{
    const existing=clients.find(client=>client.url.startsWith(self.location.origin));
    if(existing){existing.navigate(target);return existing.focus()}
    return self.clients.openWindow(target);
  }));
});
`;
