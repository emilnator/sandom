const timerNames = ["setTimeout", "clearTimeout", "setInterval", "clearInterval"];

function descriptorRecord(realm, name) {
  const descriptor = Object.getOwnPropertyDescriptor(realm, name);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new Error(`The compiled-application realm has no value descriptor for ${name}`);
  }
  if (typeof descriptor.value !== "function") {
    throw new TypeError(`The compiled-application realm ${name} must be a function`);
  }
  if (descriptor.configurable !== true && descriptor.writable !== true) {
    throw new Error(`The compiled-application realm cannot replace ${name}`);
  }
  return descriptor;
}

export function installCompiledApplicationAsyncOwnership(realm = globalThis) {
  if (!realm || (typeof realm !== "object" && typeof realm !== "function")) {
    throw new TypeError("Async ownership realm must be an object");
  }
  const descriptors = new Map(timerNames.map((name) => [
    name,
    descriptorRecord(realm, name),
  ]));
  const hostSetTimeout = descriptors.get("setTimeout").value;
  const hostClearTimeout = descriptors.get("clearTimeout").value;
  const hostSetInterval = descriptors.get("setInterval").value;
  const hostClearInterval = descriptors.get("clearInterval").value;
  const timeouts = new Set();
  const intervals = new Set();
  const sockets = new Set();
  let disposed = false;
  let restored = false;
  const ownershipEvidence = () => Object.freeze({
    pendingTimeoutCount: timeouts.size,
    pendingIntervalCount: intervals.size,
    ownedWebSocketCount: sockets.size,
  });

  const setTimeout = (callback, delay = 0, ...arguments_) => {
    if (disposed) throw new Error("Async ownership is disposed");
    let identifier;
    if (typeof callback === "function") {
      const invoke = (...callbackArguments) => {
        timeouts.delete(identifier);
        return Reflect.apply(callback, realm, callbackArguments);
      };
      identifier = Reflect.apply(hostSetTimeout, realm, [
        invoke,
        delay,
        ...arguments_,
      ]);
    } else {
      identifier = Reflect.apply(hostSetTimeout, realm, [
        callback,
        delay,
        ...arguments_,
      ]);
    }
    timeouts.add(identifier);
    return identifier;
  };
  const clearTimeout = (identifier) => {
    timeouts.delete(identifier);
    return Reflect.apply(hostClearTimeout, realm, [identifier]);
  };
  const setInterval = (callback, delay = 0, ...arguments_) => {
    if (disposed) throw new Error("Async ownership is disposed");
    const invoke = typeof callback === "function"
      ? (...callbackArguments) =>
        Reflect.apply(callback, realm, callbackArguments)
      : callback;
    const identifier = Reflect.apply(hostSetInterval, realm, [
      invoke,
      delay,
      ...arguments_,
    ]);
    intervals.add(identifier);
    return identifier;
  };
  const clearInterval = (identifier) => {
    intervals.delete(identifier);
    return Reflect.apply(hostClearInterval, realm, [identifier]);
  };
  for (const [name, value] of Object.entries({
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  })) {
    Object.defineProperty(realm, name, {
      ...descriptors.get(name),
      value,
    });
  }

  return Object.freeze({
    trackWebSocket(socket) {
      if (disposed) throw new Error("Async ownership is disposed");
      if (!socket || typeof socket !== "object" || typeof socket.close !== "function") {
        throw new TypeError("Tracked WebSocket must have a close method");
      }
      sockets.add(socket);
      if (typeof socket.addEventListener === "function") {
        socket.addEventListener("close", () => sockets.delete(socket), { once: true });
      }
      return socket;
    },
    get evidence() {
      return ownershipEvidence();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const errors = [];
      for (const identifier of timeouts) {
        try {
          Reflect.apply(hostClearTimeout, realm, [identifier]);
        } catch (error) {
          errors.push(error);
        }
      }
      timeouts.clear();
      for (const identifier of intervals) {
        try {
          Reflect.apply(hostClearInterval, realm, [identifier]);
        } catch (error) {
          errors.push(error);
        }
      }
      intervals.clear();
      for (const socket of sockets) {
        try {
          socket.close(1000, "Sandom component session disposed");
        } catch (error) {
          errors.push(error);
        }
      }
      sockets.clear();
      if (errors.length > 0) {
        throw new AggregateError(errors, "Compiled-application async disposal failed");
      }
    },
    restore() {
      if (restored) return;
      if (!disposed) {
        throw new Error("Dispose async ownership before descriptor restoration");
      }
      restored = true;
      const errors = [];
      for (const [name, descriptor] of descriptors) {
        try {
          Object.defineProperty(realm, name, descriptor);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          "Compiled-application async descriptor restoration failed",
        );
      }
    },
  });
}
