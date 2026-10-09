import { createCanvasPresenter } from "../canvas-presentation.js";
import { startPreparedRenderSurface } from "./render-animation.js";
import {
  prepareBrowserRenderInput,
  serializeBrowserWorkerError,
} from "./browser-render-worker-runtime.js";
import {
  BROWSER_PREVIEW_ERROR_KIND,
  BROWSER_PREVIEW_FRAME_KIND,
  BROWSER_PREVIEW_PROTOCOL_VERSION,
  BROWSER_PREVIEW_READY_KIND,
  BROWSER_PREVIEW_RESIZE_KIND,
  BROWSER_PREVIEW_START_KIND,
  BROWSER_PREVIEW_STOP_KIND,
} from "./browser-preview-worker-protocol.js";

let operation = null;

async function stopOperation() {
  if (operation === null) return;
  const current = operation;
  operation = null;
  current.presenter?.destroy();
  await current.session.release();
  await current.preparedInput.release();
}

self.onmessage = async (event) => {
  const message = event.data;
  try {
    if (message?.version !== BROWSER_PREVIEW_PROTOCOL_VERSION) {
      throw new RangeError(
        `Unsupported browser preview request version ${
          JSON.stringify(message?.version)
        }`,
      );
    }
    if (message.kind === BROWSER_PREVIEW_START_KIND) {
      await stopOperation();
      if (!(message.canvas instanceof OffscreenCanvas)) {
        throw new TypeError("Browser preview requires an OffscreenCanvas");
      }
      const { width, height, deviceScale = 1 } = message.viewport ?? {};
      if (
        !Number.isInteger(width) || width <= 0 ||
        !Number.isInteger(height) || height <= 0 ||
        !(Number.isFinite(deviceScale) && deviceScale > 0)
      ) {
        throw new RangeError("Browser preview viewport is invalid");
      }
      message.canvas.width = width * deviceScale;
      message.canvas.height = height * deviceScale;
      const preparedInput = await prepareBrowserRenderInput(message);
      let presenter = null;
      let frameSequence = 0;
      let session;
      try {
        session = await startPreparedRenderSurface(preparedInput, {
          viewportWidth: width,
          viewportHeight: height,
          deviceScale,
          presentFrame(rendered) {
            if (presenter === null) {
              presenter = createCanvasPresenter({
                canvas: message.canvas,
                device: rendered.device,
              });
            }
            presenter.present(rendered.textureImage);
            self.postMessage({
              kind: BROWSER_PREVIEW_FRAME_KIND,
              version: BROWSER_PREVIEW_PROTOCOL_VERSION,
              identifier: message.identifier,
              frameSequence: frameSequence++,
              width,
              height,
            });
          },
        });
      } catch (error) {
        presenter?.destroy();
        await preparedInput.release();
        throw error;
      }
      operation = {
        identifier: message.identifier,
        canvas: message.canvas,
        preparedInput,
        session,
        presenter,
        deviceScale,
      };
      self.postMessage({
        kind: BROWSER_PREVIEW_READY_KIND,
        version: BROWSER_PREVIEW_PROTOCOL_VERSION,
        identifier: message.identifier,
        input: preparedInput.input,
        resources: preparedInput.resources,
        diagnostics: preparedInput.diagnostics,
        viewport: { width, height, deviceScale },
      });
      return;
    }
    if (operation === null || message.identifier !== operation.identifier) {
      return;
    }
    if (message.kind === BROWSER_PREVIEW_RESIZE_KIND) {
      const { width, height } = message.viewport ?? {};
      if (
        !Number.isInteger(width) || width <= 0 ||
        !Number.isInteger(height) || height <= 0
      ) {
        throw new RangeError("Browser preview viewport is invalid");
      }
      operation.canvas.width = width * operation.deviceScale;
      operation.canvas.height = height * operation.deviceScale;
      operation.session.surface.viewport.resizeTo(
        width,
        height,
        operation.deviceScale,
      );
      return;
    }
    if (message.kind === BROWSER_PREVIEW_STOP_KIND) {
      await stopOperation();
      self.close();
      return;
    }
    throw new TypeError(
      `Unknown browser preview request ${JSON.stringify(message.kind)}`,
    );
  } catch (error) {
    self.postMessage({
      kind: BROWSER_PREVIEW_ERROR_KIND,
      version: BROWSER_PREVIEW_PROTOCOL_VERSION,
      identifier: message?.identifier ?? null,
      error: serializeBrowserWorkerError(error),
    });
  }
};

self.postMessage({
  kind: BROWSER_PREVIEW_READY_KIND,
  version: BROWSER_PREVIEW_PROTOCOL_VERSION,
  identifier: null,
});
