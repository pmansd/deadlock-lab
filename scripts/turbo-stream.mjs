// Minimal decoder for the React Router "turbo-stream" payloads served by
// Deadfrag's `.data` routes. Only the first line (the synchronous payload)
// is decoded; streamed promises are left as { __promise: id } markers.
const CONSTANTS = {
  "-1": undefined, // hole
  "-2": NaN,
  "-3": -Infinity,
  "-4": -0,
  "-5": null,
  "-6": Infinity,
  "-7": undefined,
};

export function decodeTurboStream(text) {
  const firstLine = text.split("\n").find((l) => l.trim().length > 0);
  if (!firstLine) throw new Error("Empty turbo-stream payload");
  const arr = JSON.parse(firstLine);
  const memo = new Map();

  function hydrate(i) {
    if (i < 0) return CONSTANTS[String(i)];
    if (memo.has(i)) return memo.get(i);
    const v = arr[i];
    if (v === null || typeof v !== "object") {
      memo.set(i, v);
      return v;
    }
    if (Array.isArray(v)) {
      if (typeof v[0] === "string") {
        const tag = v[0];
        let out;
        switch (tag) {
          case "D": out = new Date(v[1]); break;
          case "P": out = { __promise: v[1] }; break;
          case "S": out = Symbol.for(v[1]); break;
          case "E": out = new Error(v[1]); break;
          case "Z": out = null; break;
          case "M": {
            out = new Map(); memo.set(i, out);
            for (let k = 1; k < v.length; k += 2) out.set(hydrate(v[k]), hydrate(v[k + 1]));
            return out;
          }
          case "$": {
            out = new Set(); memo.set(i, out);
            for (let k = 1; k < v.length; k++) out.add(hydrate(v[k]));
            return out;
          }
          default: out = { __type: tag, raw: v };
        }
        memo.set(i, out);
        return out;
      }
      const out = [];
      memo.set(i, out);
      for (const x of v) out.push(hydrate(x));
      return out;
    }
    const obj = {};
    memo.set(i, obj);
    for (const key of Object.keys(v)) {
      obj[arr[Number(key.slice(1))]] = hydrate(v[key]);
    }
    return obj;
  }

  return hydrate(0);
}
