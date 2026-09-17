import { domCoreForWrapper, sharedDomCore } from "../dom-wasm/core.js";
import {
  createCSSBindings,
  createDOMImplementationBinding,
  installDocumentConstructionBindings,
  installElementMarkupBindings,
  installFragmentMarkupBindings,
  installScriptBindings,
  installShadowMarkupBindings,
} from "./dom-bindings.generated.js";

// Numeric property operands in the native immutable markup stage records.
// This is language spelling/identity transport, not a mutation decision table.
const properties = [
  "firstChild", "removeChild", "appendChild", "ownerDocument", "createTextNode",
  "textContent", "localName", "content", "_xmlDocument", "parentNode", "nodeType",
  "parentElement", "createElement", "insertBefore", "nextSibling", "host",
  "_domCore", "_coreHandle", "toLowerCase", "parseHTMLFragment", "parseXMLFragment",
  "serializeHTMLNode", "serializeXMLNode", "serializeHTMLNodeContents",
  "serializeXMLNodeContents", "SDTextNode", "SDElement",
  "customElements", "_construct", "_createUncustomizedElement", "is", "append",
  "SDDocument", "html", "head", "title",
  "getAttribute", "src", "baseURI", "about:blank", "href",
  "supportsCondition", "(", ": ", ")", "length", "charCodeAt", "toString",
  "\uFFFD", "\\", " ", "\\-",
  "_names", "map", "join", "getPropertyPriority", "getPropertyValue",
  " !important", ";",
  "querySelector", "base[href]", "URL",
  "_assertMutationAllowed", "indexOf", ":", "slice", "withCustomElementReactions",
  "_setParsedAttribute", "_notifyMutation", "class", "attribute",
];
const exceptionNames = { 3: "SyntaxError", 19: "NoModificationAllowedError" };

// Escaping callbacks retain only their language runtime, lexical owner and
// native callback mode, never the outer invocation or its register storage.
function createStageCallback(language, owner, mode) {
  return (argument) => language.execute(owner, mode, argument);
}

function createCapturedStageCallback(language, owner, mode, captured) {
  return () => language.execute(owner, mode, undefined, undefined, undefined, captured);
}

function createMarkupLanguage(runtime) {
  const runtimes = new WeakMap();
  const language = {
    execute(receiver, mode, first, second, third, captured) {
      // WeakMap lookup adds no observable property reads before the first
      // native-requested action. Borrowed methods retain their duck typing.
      const core = domCoreForWrapper(receiver) ?? sharedDomCore;
      let ownerRuntime = runtimes.get(core);
      if (!ownerRuntime) {
        ownerRuntime = { ...runtime };
        if (runtime.SDDocument) {
          ownerRuntime.SDDocument = class extends runtime.SDDocument {
            constructor(options = {}) {
              super({ ...options, core });
            }
          };
        }
        if (runtime.withCustomElementReactions) {
          ownerRuntime.withCustomElementReactions = (operation) =>
            runtime.withCustomElementReactions(operation, core);
        }
        runtimes.set(core, ownerRuntime);
      }
      const invocation = core.handle("markup_begin", mode);
      const registers = [receiver, first, second, undefined, null, "", "body", ownerRuntime];
      registers[20] = third;
      registers[21] = captured;
      let returned;
      let failed = false;
      try {
        for (;;) {
          const token = core.handle("markup_next", invocation);
          if (token === 0n) return returned;
          const pointer = core.status("markup_stage", invocation);
          const bytes = core.refreshBytes();
          // Snapshot every instruction operand before an observable action:
          // getters/callees may recursively invoke markup and grow memory.
          const op = bytes[pointer];
          const destination = bytes[pointer + 1];
          const a = bytes[pointer + 2];
          const b = bytes[pointer + 3];
          const c = bytes[pointer + 4];
          const d = bytes[pointer + 5];
          const e = bytes[pointer + 6];
          const test = bytes[pointer + 7];
          let value;
          try {
            switch (op) {
              case 1:
                value = registers[a][properties[b]];
                break;
              case 2:
                value = registers[a]?.[properties[b]];
                break;
              case 3:
                value = registers[a];
                break;
              case 4:
                value = String(registers[a]);
                break;
              case 6:
                value = Reflect.apply(registers[a], registers[b], []);
                break;
              case 7:
                value = Reflect.apply(registers[a], registers[b], [registers[c]]);
                break;
              case 8:
                value = Reflect.apply(registers[a], registers[b], [registers[c], registers[d]]);
                break;
              case 9:
                value = Reflect.construct(registers[a], [registers[c]]);
                break;
              case 10:
                registers[a][properties[b]] = registers[c];
                break;
              case 11:
                value = registers[a] instanceof registers[b];
                break;
              case 12:
                returned = registers[a];
                break;
              case 13: {
                const messagePointer = (bytes[pointer + 8] | (bytes[pointer + 9] << 8) |
                  (bytes[pointer + 10] << 16) | (bytes[pointer + 11] << 24)) >>> 0;
                const message = core.decoder.decode(bytes.subarray(messagePointer, messagePointer + c + (d << 8)));
                if (destination === 1) throw new TypeError(message);
                throw new DOMException(message, exceptionNames[destination]);
              }
              case 14:
                value = Reflect.apply(registers[a], registers[b], [registers[c], registers[d], registers[e]]);
                break;
              case 15:
                value = { [properties[b]]: registers[a] };
                break;
              case 16:
                value = properties[a];
                break;
              case 18:
                value = URL;
                break;
              case 19:
                value = Reflect.construct(registers[a], [registers[c], registers[d]]);
                break;
              case 20:
                value = core.status("markup_index", invocation);
                break;
              case 22:
                value = registers[a] >= b;
                break;
              case 23:
                value = registers[a] <= b;
                break;
              case 24:
                value = registers[a] < registers[b];
                break;
              case 25:
                value = registers[a] + registers[b];
                break;
              case 26:
                value = `${registers[a]}`;
                break;
              case 28:
                value = a;
                break;
              case 29:
                value = registers[a][registers[b]];
                break;
              case 30:
                value = createStageCallback(language, registers[a], b);
                break;
              case 31:
                value = [registers[a], registers[b], registers[c], registers[d], registers[e]];
                break;
              case 32:
                value = createCapturedStageCallback(language, registers[a], b, registers[c]);
                break;
              case 33:
                value = registers[a][b];
                break;
              case 34:
                value = Reflect.apply(registers[a], registers[b], registers[c]);
                break;
              case 35:
                value = [registers[a], registers[b], registers[c], registers[d]];
                break;
              case 36:
                // Language record construction preserves own data properties
                // and the two public result getters in their original order.
                value = {
                  type: "attributes",
                  target: registers[a],
                  attributeName: registers[b],
                  attributeNamespace: registers[c],
                  oldValue: registers[d].oldValue,
                  observers: registers[d].observers,
                };
                break;
              default:
                throw new TypeError("Unknown native markup action");
            }
          } catch (error) {
            let handled;
            try {
              handled = core.status("markup_throw", invocation, token);
            } catch {
              throw error;
            }
            if (!handled) throw error;
            // Native catch policy chooses the next stage. Do not overwrite
            // registers with a failed result or acknowledge this token twice.
            continue;
          }
          // Register3 is the immutable undefined/discard register. In particular,
          // overridden mutation methods may return arbitrary language objects.
          if (destination !== 3) registers[destination] = value;
          const flags = (value ? 1 : 0) |
            (value === null || value === undefined ? 2 : 0) |
            (typeof value === "number" ? 4 : 0) |
            (typeof value === "string" ? 8 : 0) |
            (value === null ? 16 : 0) |
            (value === undefined ? 32 : 0);
          // Only native strict-string tests need byte transport. Encoding occurs
          // immediately before ack, so no intermediate operation rotates it.
          let textPointer = 0;
          let textLength = 0;
          if ((test === 3 || (test >= 5 && test <= 8) || test === 10 || test === 14) &&
            typeof value === "string") {
            [textPointer, textLength] = core.input(value);
          }
          core.status("markup_ack", invocation, token, flags,
            typeof value === "number" ? value : 0, textPointer, textLength);
        }
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        // A pending action is abandoned, never repeated. Preserve the original
        // abrupt completion even if a hostile callback invalidated the handle.
        if (failed) {
          try {
            core.status("markup_release", invocation);
          } catch {
            // The language exception wins over an already-invalid lifetime.
          }
        } else {
          core.status("markup_release", invocation);
        }
      }
    },
  };
  return language;
}

const declarationLanguage = createMarkupLanguage({});

export function readStyleDeclarationText(declaration) {
  return declarationLanguage.execute(declaration, 19);
}

export function requireStyleDeclarationWritable(flag) {
  return sharedDomCore.status("style_declaration_guard", flag ? 1 : 0);
}

export function createCSSNamespace(runtime) {
  return Object.freeze(createCSSBindings(createMarkupLanguage(runtime)));
}

export function installMarkupBindings(prototypes, runtime) {
  const language = createMarkupLanguage(runtime);
  installElementMarkupBindings(language, prototypes.element);
  installFragmentMarkupBindings(language, prototypes.fragment);
  installShadowMarkupBindings(language, prototypes.shadow);
  installDocumentConstructionBindings(language, prototypes.document);
  installScriptBindings(language, prototypes.script);
  return (document) => createDOMImplementationBinding({
    // Generated object methods may be borrowed; this receiver is lexical.
    execute: (mode, title) => language.execute(document, mode, title),
  });
}
