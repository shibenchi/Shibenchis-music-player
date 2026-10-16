// the two transfers of an audio file in a room: sending the file of a song to the room's server, and fetching it back to keep a copy.
// the addresses and the login come from the caller (the page knows the club server and the account)

// the file goes up as the bytes of the file, with progress. resolves { status, json }
export function sendFile({ url, blob, type, token, clientId, onProgress }) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', url);
    request.withCredentials = true;
    request.setRequestHeader('Content-Type', type || blob.type || 'audio/mpeg');
    if (token) request.setRequestHeader('X-Auth-Token', token);
    if (clientId) request.setRequestHeader('X-Client-Id', clientId);
    request.upload.onprogress = (event) => { if (onProgress && event.lengthComputable) onProgress(event.loaded, event.total); };
    request.onerror = () => reject(new Error('could not reach the server'));
    request.ontimeout = () => reject(new Error('sending the file took too long'));
    request.onload = () => {
      let json = null;
      try { json = JSON.parse(request.responseText); } catch (e) { json = null; }
      resolve({ status: request.status, json });
    };
    request.send(blob);
  });
}

// the file comes back as a Blob, with progress
export async function fetchBlob(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) {
    let message = '';
    try { message = (await response.json()).error; } catch (e) { message = ''; }
    throw Object.assign(new Error(message || 'could not get the file'), { status: response.status });
  }
  const total = Number(response.headers.get('content-length')) || 0;
  const type = response.headers.get('content-type') || 'audio/mpeg';
  if (!response.body || !response.body.getReader) return new Blob([await response.arrayBuffer()], { type });
  const reader = response.body.getReader();
  const parts = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    if (onProgress) onProgress(loaded, total);
  }
  return new Blob(parts, { type });
}
