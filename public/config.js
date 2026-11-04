// Where the API lives. Set the meta tag in index.html to the backend's URL
// (e.g. https://api.yourdomain.com) when the frontend is hosted separately.
// On localhost, or when the meta is empty, the API is on this same origin.
const meta = document.querySelector('meta[name="sqft-api"]')?.content.trim().replace(/\/$/, '') ?? '';
const local = ['localhost', '127.0.0.1'].includes(location.hostname);
export const API = local ? '' : meta;
