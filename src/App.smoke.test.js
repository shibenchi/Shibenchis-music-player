import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

jest.mock('./AuthForm', () => () => null);

const createGradientStub = () => ({
  addColorStop: jest.fn()
});

const createCanvasContextStub = () => ({
  clearRect: jest.fn(),
  createRadialGradient: jest.fn(createGradientStub),
  createLinearGradient: jest.fn(createGradientStub),
  beginPath: jest.fn(),
  arc: jest.fn(),
  fill: jest.fn(),
  fillRect: jest.fn()
});

function createFetchResponse(body, contentType = 'application/json') {
  return {
    ok: true,
    headers: {
      get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null)
    },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  };
}

describe('App smoke render', () => {
  let container;
  let root;
  let originalFetch;
  let originalRequestAnimationFrame;
  let originalCancelAnimationFrame;
  let originalMediaPlay;
  let originalMediaPause;
  let originalMediaLoad;
  let originalCanvasGetContext;
  let originalResizeObserver;
  let originalScrollTo;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    originalFetch = global.fetch;
    originalRequestAnimationFrame = global.requestAnimationFrame;
    originalCancelAnimationFrame = global.cancelAnimationFrame;
    originalMediaPlay = window.HTMLMediaElement.prototype.play;
    originalMediaPause = window.HTMLMediaElement.prototype.pause;
    originalMediaLoad = window.HTMLMediaElement.prototype.load;
    originalCanvasGetContext = window.HTMLCanvasElement.prototype.getContext;
    originalResizeObserver = global.ResizeObserver;
    originalScrollTo = window.scrollTo;

    global.fetch = jest.fn((url) => {
      if (url === '/package.json') {
        return Promise.resolve(createFetchResponse({ version: '1.0.4' }));
      }
      if (url === '/api/version') {
        return Promise.resolve(createFetchResponse({ version: '1.0.4' }));
      }
      return Promise.resolve(createFetchResponse({}));
    });

    global.requestAnimationFrame = jest.fn(() => 1);
    global.cancelAnimationFrame = jest.fn();
    window.HTMLMediaElement.prototype.play = jest.fn(() => Promise.resolve());
    window.HTMLMediaElement.prototype.pause = jest.fn();
    window.HTMLMediaElement.prototype.load = jest.fn();
    window.HTMLCanvasElement.prototype.getContext = jest.fn(() => createCanvasContextStub());
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    window.scrollTo = jest.fn();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    global.fetch = originalFetch;
    global.requestAnimationFrame = originalRequestAnimationFrame;
    global.cancelAnimationFrame = originalCancelAnimationFrame;
    window.HTMLMediaElement.prototype.play = originalMediaPlay;
    window.HTMLMediaElement.prototype.pause = originalMediaPause;
    window.HTMLMediaElement.prototype.load = originalMediaLoad;
    window.HTMLCanvasElement.prototype.getContext = originalCanvasGetContext;
    global.ResizeObserver = originalResizeObserver;
    window.scrollTo = originalScrollTo;
    jest.clearAllMocks();
  });

  test('renders without throwing a runtime initialization error', async () => {
    await act(async () => {
      root.render(
        <App
          user={null}
          onLogin={() => {}}
          onLogout={() => {}}
        />
      );
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("Something went wrong.");
    expect(global.fetch).toHaveBeenCalledWith('/package.json');
  });
});
