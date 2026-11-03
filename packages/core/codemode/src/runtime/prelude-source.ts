import { LOCKDOWN_SOURCE } from "./lockdown-source.ts";
import { CODEMODE_LIMITS } from "../limits.ts";

/** The bridge stays in a closure; functions and host objects never enter the VM. */
export const PRELUDE_SOURCE = `(bridge, toolsJson, storeJson, globalsJson) => {
  ${LOCKDOWN_SOURCE};
  const pending = new Map();
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  let nextId = 0;
  let done = false;
  let outputChars = 0;
  let outputItems = 0;
  const describeError = error => {
    try { return stringify({name: String(error?.name ?? 'Error'), message: String(error?.message ?? error), stack: typeof error?.stack === 'string' ? error.stack : undefined}); }
    catch { return stringify({message: 'Script threw an indescribable value'}); }
  };
  const fail = error => {
    if (done) return;
    done = true; bridge('done', false, describeError(error));
  };
  const budget = chars => {
    if (outputChars + chars > ${CODEMODE_LIMITS.outputChars} || outputItems + 1 > ${CODEMODE_LIMITS.outputItems}) {
      const error = new RangeError('Script output exceeded its limit');
      fail(error); throw error;
    }
    outputChars += chars; outputItems++;
  };
  const stored = new Map(Object.entries(parse(storeJson)));
  let storedChars = [...stored].reduce((sum, [key, json]) => sum + key.length + json.length, 0);
  const writes = new Map();
  const complete = value => {
    if (done) return;
    try {
      if (typeof value === 'string') budget(value.length);
      const encoded = stringify(value);
      if (value !== undefined && typeof value !== 'string') {
        if (encoded === undefined) throw new TypeError('Return value must be JSON serializable');
        budget(encoded.length);
      }
      const encodedWrites = stringify([...writes].map(([key, json]) => json === undefined ? [key] : [key, json]));
      done = true;
      bridge('done', true, encoded, encodedWrites);
    } catch (error) { fail(error); }
  };
  const EXIT = Object.freeze({});
  Object.defineProperty(globalThis, 'exit', { value: () => { complete(undefined); throw EXIT; } });
  const checkKey = key => { if (typeof key !== 'string') throw new TypeError('store/load key must be a string'); };
  Object.defineProperty(globalThis, 'store', { value: (key, value) => {
    checkKey(key);
    const previous = stored.has(key) ? key.length + stored.get(key).length : 0;
    if (value === undefined) { stored.delete(key); storedChars -= previous; writes.set(key, undefined); return; }
    const json = stringify(value);
    if (json === undefined) throw new TypeError('store value must be JSON serializable');
    if (json.length > ${CODEMODE_LIMITS.storeValueChars}) throw new RangeError('Store value exceeded its JSON character limit');
    const next = storedChars - previous + key.length + json.length;
    if (next > ${CODEMODE_LIMITS.storeTotalChars}) throw new RangeError('Total store exceeded its character limit');
    storedChars = next;
    stored.set(key, json); writes.set(key, json);
  } });
  Object.defineProperty(globalThis, 'load', { value: key => {
    checkKey(key); const json = stored.get(key); return json === undefined ? undefined : parse(json);
  } });
  Object.defineProperty(globalThis, 'text', { value: value => {
    if (done) return;
    const rendered = typeof value === 'object' && value !== null ? stringify(value) : String(value);
    budget(rendered.length);
    bridge('output', rendered);
  } });
  const console = Object.create(null);
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) console[level] = (...values) => {
    if (done) return;
    const rendered = values.map(value => value instanceof Error ? String(value) : typeof value === 'object' && value !== null ? stringify(value) : String(value)).join(' ');
    budget(rendered.length); bridge('output', rendered, true);
  };
  Object.defineProperty(globalThis, 'console', {value: Object.freeze(console)});
  Object.defineProperty(globalThis, 'image', { value: value => {
    if (done) return;
    if (value && typeof value === 'object' && value.type === 'image' && typeof value.attachment_id === 'string' && value.attachment_id) {
      if (value.view !== undefined && (!value.view || typeof value.view !== 'object' || Array.isArray(value.view))) throw new TypeError('Invalid image view');
      const source = {attachment_id: value.attachment_id, ...(value.view === undefined ? {} : {view: value.view})};
      const encoded = stringify(source);
      budget(value.attachment_id.length + (value.view === undefined ? 0 : stringify(value.view).length));
      bridge('image', encoded); return;
    }
    let url;
    if (typeof value === 'string') url = value;
    else if (value && typeof value === 'object' && typeof value.image_url === 'string') url = value.image_url;
    else if (value && value.type === 'image' && typeof value.data === 'string') url = value.data.toLowerCase().startsWith('data:') ? value.data : 'data:;base64,' + value.data;
    if (typeof url !== 'string' || !/^data:[^,]*;base64,/i.test(url)) throw new TypeError('Image requires base64 data; remote URLs are unavailable');
    const data = url.slice(url.indexOf(',') + 1).replace(/\\s+/g, '');
    if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new TypeError('Invalid image base64');
    const signature = [
      ['image/png', /^iVBORw0KGg/], ['image/jpeg', /^[/]9j[/](?!9)/],
      ['image/gif', /^R0lGOD[dl]h/], ['image/webp', /^UklG.{8}RUJQ/]
    ].find(([, pattern]) => pattern.test(data.slice(0, 16)));
    if (!signature) throw new TypeError('Image must be PNG, JPEG, GIF, or WebP');
    budget(data.length); bridge('image', stringify({data, mimeType: signature[0]}));
  } });
  const tools = Object.create(null);
  const caller = (kind, name, spread) => (...args) => new Promise((resolve, reject) => {
      if (done) { reject(new Error('Script execution has ended')); return; }
      const id = ++nextId;
      const encoded = stringify(spread ? args : args[0]);
      pending.set(id, {resolve, reject});
      bridge(kind, id, name, encoded);
  });
  const allTools = [];
  for (const tool of parse(toolsJson)) {
    const fn = caller('call', tool.name, false);
    tools[tool.jsName] = fn; tools[tool.name] = fn;
    allTools.push(Object.freeze({name: tool.jsName, ...(tool.description === undefined ? {} : {description: tool.description})}));
  }
  Object.freeze(tools);
  const guard = (target, label) => new Proxy(target, {get(object, property, receiver) {
    if (typeof property !== 'string' || property in object || property in Object.prototype || property === 'then' || property === 'toJSON') return Reflect.get(object, property, receiver);
    throw new TypeError(label + '.' + property + ' does not exist. Available: ' + Object.keys(object).slice(0, 20).join(', ') + '. Use ALL_TOOLS and searchTools to discover tools.');
  }});
  const toolsProxy = guard(tools, 'tools');
  Object.defineProperty(globalThis, 'tools', { value: toolsProxy });
  Object.defineProperty(globalThis, 'ALL_TOOLS', { value: Object.freeze(allTools) });
  const namespaces = new Map();
  for (const global of parse(globalsJson)) {
    const fn = caller('global', global.name, global.spread);
    const parts = global.name.split('.');
    if (parts.length === 1) Object.defineProperty(globalThis, global.name, { value: fn });
    else {
      if (!namespaces.has(parts[0])) namespaces.set(parts[0], Object.create(null));
      namespaces.get(parts[0])[parts[1]] = fn;
    }
  }
  for (const [name, members] of namespaces) Object.defineProperty(globalThis, name, {value: guard(Object.freeze(members), name)});
  return {
    settle(id, ok, payload) {
      const call = pending.get(id);
      if (!call) throw new Error('Unknown host response ID');
      pending.delete(id);
      if (ok) call.resolve(payload === undefined ? undefined : parse(payload));
      else call.reject(new Error(payload));
    },
    run(fn) {
      fn(toolsProxy).then(complete, fail);
    },
    stalled() {
      if (!done && pending.size === 0) {
        done = true;
        bridge('done', false, stringify({message: 'Script is stalled: no pending host calls can resume it.'}));
      }
    }
  };
}`;
