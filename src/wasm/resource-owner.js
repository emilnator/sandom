// IDs identify concrete host objects across native modules in this host realm.
// They neither retain an object nor prove a native allocation is still live.
const identities = new WeakMap();
let nextIdentity = 1n;
const lastIdentity = (1n << 64n) - 1n;

export function resourceOwnerIdentity(owner) {
  if (owner === null || (typeof owner !== "object" && typeof owner !== "function")) {
    throw new TypeError("A resource owner must be a concrete object");
  }
  let identity = identities.get(owner);
  if (identity === undefined) {
    if (nextIdentity > lastIdentity) throw new RangeError("Resource owner identity capacity exhausted");
    identity = nextIdentity++;
    identities.set(owner, identity);
  }
  return identity;
}

export function isResourceOwner(owner, identity) {
  return typeof identity === "bigint" && identity !== 0n &&
    identities.get(owner) === identity;
}
