export async function registerServiceWorker({
  serviceWorker = navigator.serviceWorker,
  baseUrl = import.meta.env.BASE_URL,
  reload = () => window.location.reload()
} = {}) {
  const replacingController = Boolean(serviceWorker.controller);
  let reloading = false;
  serviceWorker.addEventListener("controllerchange", () => {
    if (!replacingController || reloading) return;
    reloading = true;
    reload();
  });
  const registration = await serviceWorker.register(`${baseUrl}sw.js`, {
    type: "module",
    updateViaCache: "none"
  });
  await registration.update();
  return registration;
}
