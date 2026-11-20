// Forms & validation QA.
// Safe mode (default): static inspection + constraint checks on *detached copies* of fields — the page is not touched.
// Interactive mode (opt-in): fills real fields with synthetic values, triggers validation with every submission blocked,
// then restores the original values. Original values are never read into results or exported.
(function () {
  "use strict";
  const QA = window.__webQA;
  const h = QA.h;
  const U = window.__webQAUtils;

  const SKIP_TYPES = /^(hidden|submit|button|reset|image)$/;

  function fieldsOf(scope) {
    const list = scope.elements ? [...scope.elements] : [...scope.querySelectorAll("input, select, textarea")];
    return list.filter((f) => f.matches("input, select, textarea") && !SKIP_TYPES.test((f.type || "").toLowerCase()));
  }

  function hintText(f) {
    const label = f.labels && f.labels.length ? [...f.labels].map((l) => l.textContent).join(" ") : "";
    return [f.name, f.id, f.getAttribute("autocomplete"), f.getAttribute("placeholder"), f.getAttribute("aria-label"), label].filter(Boolean).join(" ").toLowerCase();
  }

  function visibleLabelText(f) {
    const parts = [];
    if (f.labels) for (const l of f.labels) parts.push(l.textContent || "");
    const lb = f.getAttribute("aria-labelledby");
    if (lb) lb.split(/\s+/).forEach((id) => parts.push(document.getElementById(id)?.textContent || ""));
    return parts.join(" ");
  }

  function submitButtons(form) {
    return [...form.querySelectorAll("button, input[type=submit], input[type=image]")].concat(form.id ? [...document.querySelectorAll(`[form="${CSS.escape(form.id)}"]`)] : [])
      .filter((b) => b.matches("button:not([type]), button[type=submit], input[type=submit], input[type=image]"));
  }

  function blocksImplicitSubmission(f) {
    return f.localName === "input" && /^(text|search|url|tel|email|password|date|month|week|time|datetime-local|number)$/.test((f.type || "text").toLowerCase());
  }

  function looksLike(f) {
    const t = hintText(f);
    return {
      email: /e-?mail/.test(t),
      url: /\b(url|website|homepage|web site)\b/.test(t),
      tel: /\b(phone|tel|mobile|telephone)\b/.test(t),
      password: /\b(password|passwort|pwd|passcode)\b/.test(t) && !/(forgot|reset|hint)/.test(t),
      search: /search|query|\bq\b/.test(t),
    };
  }

  function nativeSetValue(el, v) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
    if (proto) Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
    else if (el.isContentEditable) el.textContent = v;
    else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function sampleValid(f) {
    const type = (f.type || "text").toLowerCase();
    const lk = looksLike(f);
    if (type === "email" || lk.email) return "qa.test@example.com";
    if (type === "url" || lk.url) return "https://example.com/";
    if (type === "tel" || lk.tel) return "+15555550100";
    if (type === "number" || type === "range") {
      const min = parseFloat(f.min);
      const max = parseFloat(f.max);
      if (Number.isFinite(min) && Number.isFinite(max)) return String(Math.round((min + max) / 2));
      if (Number.isFinite(min)) return String(min);
      if (Number.isFinite(max)) return String(max);
      return "1";
    }
    if (type === "date") return f.min || f.max || new Date().toISOString().slice(0, 10);
    if (type === "password") return "QaTest!2345";
    const minl = parseInt(f.getAttribute("minlength"), 10) || 0;
    let v = "QA test value";
    while (v.length < minl) v += " x";
    const maxl = parseInt(f.getAttribute("maxlength"), 10);
    if (maxl > 0) v = v.slice(0, maxl);
    return v;
  }

  const ERROR_SEL = '[role=alert], [aria-live="assertive"], [aria-live="polite"], .error, .errors, .invalid-feedback, .field-error, .form-error, .error-message, [class*="error" i], [class*="invalid" i]';

  function visibleErrors(scope) {
    return [...scope.querySelectorAll(ERROR_SEL)].filter((e) => !e.matches("input, select, textarea, form") && h.isVisible(e) && (e.textContent || "").trim().length > 1);
  }

  // Custom validation often shows plain text under a field ("Fill in this field") without any error class,
  // so feedback is detected as visible text that appears or changes after a submit attempt.
  const GLOBAL_MSG_SEL = '[role=alert], [role=status], [aria-live], [class*="toast" i], [class*="notif" i], [class*="snackbar" i], [class*="alert" i], [class*="message" i]';
  const ERROR_CLASS = /error|invalid|danger|is-wrong|has-warning/i;

  function textMap(form) {
    const m = new Map();
    const els = [...form.querySelectorAll("*"), ...[...document.querySelectorAll(GLOBAL_MSG_SEL)].filter((e) => !form.contains(e))];
    for (const el of els) {
      if (el.matches("input, select, textarea, option, script, style, template") || h.isOwnNode(el)) continue;
      let own = "";
      for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent;
      own = own.trim();
      if (!own || !h.isVisible(el)) continue;
      m.set(el, own);
    }
    return m;
  }

  function newMessages(before, form) {
    const out = [];
    for (const [el, text] of textMap(form)) if (before.get(el) !== text && /\p{L}{2}/u.test(text)) out.push({ el, text });
    return out;
  }

  const classTokens = (f) => new Set([...f.classList, ...(f.parentElement ? f.parentElement.classList : [])]);

  function fieldState(fields) {
    return new Map(fields.map((f) => [f, { invalid: f.getAttribute("aria-invalid") === "true", cls: classTokens(f) }]));
  }

  function fieldFlagged(f, base) {
    const b = base.get(f);
    if (!b) return false;
    if (f.getAttribute("aria-invalid") === "true" && !b.invalid) return true;
    return [...classTokens(f)].some((c) => !b.cls.has(c) && ERROR_CLASS.test(c));
  }

  function nearField(f, el) {
    let p = f.parentElement;
    for (let i = 0; p && i < 3 && p !== document.body; i++, p = p.parentElement) {
      if (p.contains(el) && p.querySelectorAll("input, select, textarea").length <= 2) return true;
    }
    return !!(f.getAttribute("aria-describedby") || "").split(/\s+/).some((id) => id && document.getElementById(id)?.contains(el));
  }

  function listenNetworkBlocks() {
    const list = [];
    const on = (e) => {
      try {
        list.push(JSON.parse(e.detail));
      } catch {
        list.push({ kind: "request" });
      }
    };
    window.addEventListener("__webqa-net-blocked", on);
    return { list, stop: () => window.removeEventListener("__webqa-net-blocked", on) };
  }

  // ---------------- static checks ----------------

  async function staticChecks(ctx, groups) {
    const T = (id, name) => ({ id, name, n: 0 });
    const tests = {
      submit: T("forms.submit-mechanism", "Form has a usable submission mechanism"),
      label: T("forms.labels", "Fields have labels"),
      name: T("forms.field-names", "Fields have name attributes"),
      reqMismatch: T("forms.required-constraint", "Fields that look mandatory have required"),
      type: T("forms.input-types", "Appropriate input types"),
      autocomplete: T("forms.password-autocomplete", "Password autocomplete configuration"),
      errors: T("forms.error-association", "Error messages are associated with fields"),
      focus: T("forms.field-operable", "Fields can receive focus and input"),
    };
    const add = (k, p) => {
      tests[k].n++;
      ctx.add({ testId: tests[k].id, name: tests[k].name, ...p });
    };

    for (const g of groups) {
      await ctx.tick();
      const { form, fields } = g;
      const visibleFields = fields.filter((f) => h.isVisible(f) && !h.isAriaHidden(f));
      if (!visibleFields.length) continue;

      if (form) {
        const subs = submitButtons(form);
        const implicitBlockers = fields.filter(blocksImplicitSubmission);
        if (!subs.length && implicitBlockers.length > 1) {
          add("submit", {
            element: form,
            status: "warning",
            severity: "medium",
            verification: "inferred",
            message: `Form has ${implicitBlockers.length} text-like fields and no submit button, so pressing Enter does not submit it (HTML implicit submission rule). Script-driven buttons may exist but are not type=submit.`,
            actual: "no submit button",
            expected: "a <button type=submit> (or input[type=submit])",
            fix: "Add a submit button; if a custom button submits via script, make it type=submit so Enter works.",
          });
        }
        const disabledSubs = subs.filter((b) => b.disabled || b.getAttribute("aria-disabled") === "true");
        if (subs.length && disabledSubs.length === subs.length) {
          const explained = disabledSubs.some((b) => b.getAttribute("aria-describedby") || b.title);
          ctx.add({
            testId: "forms.disabled-submit",
            name: "Disabled submit button",
            element: disabledSubs[0],
            status: "manual",
            severity: explained ? "info" : "low",
            verification: "manual",
            message: `All submit buttons are disabled${explained ? "" : " with no aria-describedby/title explaining why"}. Verify users understand what must be done to enable submission (disabled buttons are also skipped by screen-reader Tab navigation).`,
            fix: "Prefer an enabled submit button that shows validation errors, or explain the requirement next to it.",
          });
        }
        if (form.noValidate) {
          ctx.limitation(`${h.cssPath(form)} has novalidate: native validation is off and custom JavaScript validation must be verified manually or with interactive mode.`);
        }
      }

      const hasAction = form && (form.hasAttribute("action") || form.hasAttribute("method"));
      for (const f of visibleFields) {
        const type = (f.type || "text").toLowerCase();
        const { name, source } = h.accessibleName(f);
        if (!name) {
          add("label", {
            element: f,
            status: "failed",
            severity: "medium",
            verification: "verified",
            message: `${f.localName}[type=${type}] has no label, aria-label or aria-labelledby.`,
            actual: "no accessible name",
            expected: "<label for> or aria-label",
            fix: "Associate a visible <label for=\"id\"> with the field.",
          });
        } else if (source === "placeholder" || source === "title") {
          add("label", {
            element: f,
            status: "warning",
            severity: "medium",
            verification: "verified",
            message: `Field is named only by its ${source} ("${U.truncate(name, 40)}"); ${source === "placeholder" ? "the hint disappears while typing and is often low-contrast" : "title is not reliably announced"}.`,
            actual: `name from ${source}`,
            expected: "a persistent visible label",
            fix: "Add a visible <label>; keep the placeholder only as an example value.",
          });
        }

        if (!f.name && !f.id && hasAction && type !== "file") {
          add("name", {
            element: f,
            status: "warning",
            severity: "medium",
            verification: "inferred",
            message: "Field has no name attribute, so its value is not included in a native form submission.",
            actual: "no name",
            expected: "name attribute",
            fix: "Add a name attribute (unless the form is submitted entirely by script).",
          });
        } else if (!f.name && hasAction && type !== "file") {
          add("name", {
            element: f,
            status: "warning",
            severity: "low",
            verification: "inferred",
            message: "Field has an id but no name attribute; native submission ignores it.",
            actual: "no name",
            expected: "name attribute",
            fix: "Add a name attribute.",
          });
        }

        const labelText = visibleLabelText(f);
        const markedRequired = /\*|\(required\)|\brequired\b|обязательн/i.test(labelText);
        const isRequired = f.required || f.getAttribute("aria-required") === "true";
        if (markedRequired && !isRequired) {
          add("reqMismatch", {
            element: f,
            status: "manual",
            severity: "info",
            verification: "manual",
            message: "Label marks the field as required but it has no required/aria-required attribute, so it is probably validated by script. That is fine if a message appears when it is left empty — enable \"Interactive form tests\" to verify it automatically. Screen readers only announce the field as required with aria-required=\"true\".",
            actual: "no required/aria-required attribute",
            expected: 'custom validation message, ideally with aria-required="true"',
            fix: 'Optional: add aria-required="true" (keeps your custom validation, improves accessibility).',
          });
        }
        const lk = looksLike(f);
        const generic = type === "text" || type === "";
        let want = null;
        if (lk.password && type === "text") want = "password";
        else if (lk.email && generic) want = "email";
        else if (lk.url && generic) want = "url";
        else if (lk.tel && generic) want = "tel";
        if (want) {
          add("type", {
            element: f,
            status: "warning",
            severity: want === "password" ? "high" : "low",
            verification: "inferred",
            message: want === "password" ? "Field looks like a password field but is type=\"text\": the password is displayed in clear text." : `Field looks like ${want === "tel" ? "a phone number" : `a${want === "email" ? "n" : ""} ${want}`} field but is type="${type}" — no native validation and no matching mobile keyboard.`,
            actual: `type="${type}"`,
            expected: `type="${want}"`,
            evidence: { hint: U.truncate(hintText(f), 80) },
            fix: `Use type="${want}"${want === "email" ? ' with autocomplete="email"' : ""}.`,
          });
        }

        if (type === "password") {
          const ac = (f.getAttribute("autocomplete") || "").toLowerCase();
          if (ac === "off") {
            add("autocomplete", {
              element: f,
              status: "warning",
              severity: "low",
              verification: "verified",
              message: 'Password field has autocomplete="off", which hinders password managers (most browsers ignore it anyway).',
              actual: 'autocomplete="off"',
              expected: 'autocomplete="current-password" or "new-password"',
              fix: 'Use autocomplete="current-password" for login and "new-password" for sign-up/change forms.',
            });
          } else if (!ac) {
            add("autocomplete", {
              element: f,
              status: "warning",
              severity: "info",
              verification: "verified",
              message: "Password field has no autocomplete hint.",
              actual: "no autocomplete",
              expected: 'autocomplete="current-password" or "new-password"',
              fix: "Add the appropriate autocomplete token.",
            });
          }
        }

        if (f.getAttribute("aria-invalid") === "true") {
          const desc = (f.getAttribute("aria-describedby") || "") + " " + (f.getAttribute("aria-errormessage") || "");
          const ids = desc.trim().split(/\s+/).filter(Boolean);
          const texts = ids.map((id) => document.getElementById(id)).filter((e) => e && (e.textContent || "").trim());
          if (!texts.length) {
            add("errors", {
              element: f,
              status: "failed",
              severity: "medium",
              verification: "verified",
              message: 'Field is aria-invalid="true" but no error message is referenced by aria-describedby/aria-errormessage.',
              actual: "invalid without described error",
              expected: "aria-describedby pointing at the visible error text",
              fix: "Reference the error message element's id from aria-describedby.",
            });
          }
        }

        const fcs = getComputedStyle(f);
        if (fcs.pointerEvents === "none" && !f.disabled && !f.readOnly) {
          add("focus", {
            element: f,
            status: "warning",
            severity: "medium",
            verification: "verified",
            message: "Field has pointer-events: none — it cannot be clicked into.",
            actual: "pointer-events: none",
            expected: "clickable field",
            fix: "Remove pointer-events: none (or disable the field properly).",
          });
        } else if (f.getAttribute("tabindex") !== null && parseInt(f.getAttribute("tabindex"), 10) < 0 && !f.disabled) {
          add("focus", {
            element: f,
            status: "warning",
            severity: "medium",
            verification: "verified",
            message: 'Visible field has a negative tabindex and is skipped when tabbing through the form.',
            actual: `tabindex="${f.getAttribute("tabindex")}"`,
            expected: "reachable with Tab",
            fix: "Remove the negative tabindex.",
          });
        }
      }

      // Error-looking text not associated with any field
      const scope = form || g.scope;
      const referenced = new Set();
      fields.forEach((f) => ((f.getAttribute("aria-describedby") || "") + " " + (f.getAttribute("aria-errormessage") || "")).split(/\s+/).filter(Boolean).forEach((id) => referenced.add(id)));
      for (const e of visibleErrors(scope)) {
        if (e.getAttribute("role") === "alert" || e.closest("[aria-live]")) continue;
        if (e.id && referenced.has(e.id)) continue;
        if ([...referenced].some((id) => document.getElementById(id)?.contains(e))) continue;
        if (!/[a-zа-я]{3}/i.test(e.textContent || "")) continue;
        if (e.querySelector(ERROR_SEL)) continue; // report the innermost
        add("errors", {
          element: e,
          status: "warning",
          severity: "low",
          verification: "inferred",
          message: `Visible error-like text "${U.truncate(e.textContent.trim(), 60)}" is not referenced by any field (aria-describedby) and is not a live region.`,
          actual: "not programmatically associated",
          expected: "error referenced from its field via aria-describedby, or announced via role=alert",
          fix: "Give the message an id and reference it from the field's aria-describedby (and set aria-invalid).",
        });
      }
    }
    return tests;
  }

  // ---------------- safe constraint checks on detached clones ----------------

  async function constraintChecks(ctx, groups) {
    const id = "forms.native-constraints";
    const name = "Native constraint validation (detached copies)";
    if (!ctx.shouldRun(id)) return;
    ctx.markRan(id);
    let verifiedFields = 0;
    let found = 0;
    const lengthOnly = [];
    for (const g of groups) {
      for (const f of g.fields) {
        await ctx.tick();
        if (!h.isVisible(f) || f.localName !== "input") continue;
        const type = (f.type || "text").toLowerCase();
        if (/^(checkbox|radio|file|color|range)$/.test(type)) continue;
        const c = f.cloneNode(false);
        c.removeAttribute("id");
        c.removeAttribute("name");
        const check = (v) => {
          c.value = v;
          return c.validity;
        };
        verifiedFields++;
        const lk = looksLike(f);
        if (f.required) {
          if (!check("").valueMissing) {
            found++;
            ctx.add({ testId: id, name, element: f, status: "failed", severity: "medium", verification: "verified", message: "required field accepts an empty value.", fix: "Check the field type/attributes." });
          }
        }
        if (type === "email" || lk.email) {
          const bad = check("not-an-email");
          if (bad.valid) {
            found++;
            ctx.add({
              testId: id,
              name,
              element: f,
              status: "warning",
              severity: "medium",
              verification: "verified",
              message: 'Email-like field accepts "not-an-email" under native validation. Custom script validation may still catch it — verify with interactive mode.',
              actual: '"not-an-email" is valid',
              expected: "typeMismatch / patternMismatch",
              evidence: { testValue: "not-an-email", type },
              fix: 'Use type="email" (and optionally a pattern).',
            });
          }
          const good = check("qa.test@example.com");
          if (!good.valid && !good.tooShort && !good.tooLong) {
            found++;
            ctx.add({ testId: id, name, element: f, status: "warning", severity: "medium", verification: "verified", message: 'A valid-looking address "qa.test@example.com" is rejected by the field\'s constraints (pattern?).', actual: "valid email rejected", expected: "accepted", evidence: { pattern: f.pattern || null }, fix: "Relax the pattern so ordinary addresses are accepted." });
          }
        }
        if (type === "url" || lk.url) {
          if (check("not a url").valid) {
            found++;
            ctx.add({ testId: id, name, element: f, status: "warning", severity: "low", verification: "verified", message: 'URL-like field accepts "not a url" under native validation.', actual: '"not a url" is valid', expected: "typeMismatch", evidence: { testValue: "not a url" }, fix: 'Use type="url".' });
          }
        }
        if (type === "text" && (f.min !== "" || f.max !== "")) {
          found++;
          ctx.add({ testId: id, name, element: f, status: "warning", severity: "low", verification: "verified", message: `min/max are set on a type="text" field, where browsers ignore them.`, actual: `type="text" min="${f.min}" max="${f.max}"`, expected: 'type="number" (or date/time)', fix: "Use a numeric/date input type, or validate the range in script." });
        }
        if (f.pattern) {
          let re = null;
          try {
            re = new RegExp(`^(?:${f.pattern})$`, "v");
          } catch {
            try {
              re = new RegExp(`^(?:${f.pattern})$`, "u");
            } catch {
              found++;
              ctx.add({ testId: id, name, element: f, status: "failed", severity: "medium", verification: "verified", message: `pattern="${U.truncate(f.pattern, 60)}" is not a valid regular expression, so browsers ignore it.`, actual: "invalid pattern", expected: "valid regex", fix: "Fix the pattern syntax (it is compiled with the v flag)." });
            }
          }
          if (re) {
            const violating = ["!", "a", "1", "@@@", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"].find((v) => !re.test(v));
            if (violating && !check(violating).patternMismatch) {
              found++;
              ctx.add({ testId: id, name, element: f, status: "warning", severity: "low", verification: "verified", message: "pattern constraint did not reject a non-matching value.", actual: `"${violating}" accepted`, expected: "patternMismatch", fix: "Check the field type; pattern only applies to text-like inputs." });
            }
          }
        }
        if (f.getAttribute("minlength") || f.getAttribute("maxlength")) lengthOnly.push(h.cssPath(f));
      }
    }
    if (lengthOnly.length) {
      ctx.manual("forms.length-constraints", "minlength/maxlength enforcement", `${lengthOnly.length} field(s) use minlength/maxlength. Browsers only enforce these on user edits (and maxlength by blocking typing), so they must be verified by typing manually or with interactive mode.`, { evidence: { fields: lengthOnly.slice(0, 15) } });
    }
    if (!found && verifiedFields) {
      ctx.add({ testId: id, name, status: "passed", severity: "info", verification: "verified", message: `Native constraints behaved as configured on detached copies of ${verifiedFields} field(s). Nothing on the page was changed or submitted.` });
    } else if (!verifiedFields) {
      ctx.skip(id, name, "No visible text-like inputs to check.");
    }
  }

  // ---------------- opt-in interactive validation ----------------

  async function interactiveChecks(ctx, groups) {
    const id = "forms.interactive-validation";
    const name = "Interactive validation (submission blocked)";
    if (!ctx.shouldRun(id)) return;
    ctx.markRan(id);
    const forms = groups.filter((g) => g.form && g.fields.some((f) => h.isVisible(f)));
    if (!ctx.options.formInteractive) {
      if (forms.length) {
        ctx.manual(id, name, `Safe mode: ${forms.length} form(s) were not filled or submitted. Enable "Interactive form tests" (test environments only) to fill fields with synthetic values and trigger validation with submission blocked, or test manually: empty submit, invalid values, keyboard (Enter) submit, error display/clearing.`);
      }
      return;
    }
    // Page submit handlers (custom JS validation) may only run while the background worker has blocked the page's
    // outgoing data requests; otherwise every submit is cancelled before page scripts see it.
    const pageHandlers = !!ctx.options.networkGuard;
    const release = QA.guardNavigation({ allowPageHandlers: pageHandlers });
    const guard = release.guard;
    const net = listenNetworkBlocks();
    if (!pageHandlers) ctx.limitation("Interactive form tests ran without the network guard, so the page's own submit scripts were not executed; custom (script) validation could not be observed.");
    try {
      for (const g of forms.slice(0, 5)) {
        ctx.checkCancelled();
        const form = g.form;
        const fields = g.fields.filter((f) => h.isVisible(f) && !f.disabled && !f.readOnly && f.type !== "file");
        const saved = fields.map((f) => ({ f, v: f.value, c: f.checked, s: f.selectedIndex }));
        const prevFocus = document.activeElement;
        const invalidFired = new Set();
        const onInvalid = (e) => invalidFired.add(e.target);
        form.addEventListener("invalid", onInvalid, true);
        const trigger = submitTrigger(form, pageHandlers);
        const submitTry = async () => {
          invalidFired.clear();
          const before = guard.submits.length;
          const handledBefore = guard.pageHandled.length;
          const netBefore = net.list.length;
          const texts = textMap(form);
          const states = fieldState(fields);
          if (trigger) trigger.click();
          else if (typeof form.requestSubmit === "function") form.requestSubmit();
          guard.settle();
          await new Promise((r) => setTimeout(r, 700));
          const requests = net.list.slice(netBefore);
          return {
            submitted: guard.submits.length > before || requests.length > 0,
            nativeSubmit: guard.submits.length > before,
            requests,
            pageHandled: guard.pageHandled.length > handledBefore,
            invalid: [...invalidFired],
            messages: newMessages(texts, form),
            flagged: fields.filter((f) => fieldFlagged(f, states)),
          };
        };
        const feedbackFor = (f, r, shown) => r.invalid.includes(f) || r.flagged.includes(f) || shown.some((m) => m.el.isConnected && h.isVisible(m.el) && nearField(f, m.el));
        const baseline = textMap(form);
        try {
          // 1. empty submission
          for (const f of fields) {
            if (f.type === "checkbox" || f.type === "radio") f.checked = false;
            else if (f.localName === "select") f.selectedIndex = -1;
            else nativeSetValue(f, "");
          }
          const empty = await submitTry();
          const requiredish = fields.filter((f) => f.required || f.getAttribute("aria-required") === "true" || /\*/.test(visibleLabelText(f) + " " + (f.getAttribute("placeholder") || "")));
          const feedback = empty.invalid.length || empty.messages.length || empty.flagged.length;
          const sample = empty.messages.slice(0, 3).map((m) => U.truncate(m.text, 60));
          const how = [empty.invalid.length && `${empty.invalid.length} native invalid event(s)`, empty.messages.length && `${empty.messages.length} message(s) appeared${sample.length ? `: "${sample.join('", "')}"` : ""}`, empty.flagged.length && `${empty.flagged.length} field(s) marked invalid`].filter(Boolean).join("; ");
          const sentWhat = [empty.nativeSubmit && "a native form submission", empty.requests.length && `${empty.requests.length} data request(s) (${empty.requests.slice(0, 2).map((q) => `${q.method || ""} ${q.url || q.kind}`.trim()).join(", ")})`].filter(Boolean).join(" and ");
          if (!pageHandlers && empty.submitted && !feedback && requiredish.length && (form.noValidate || requiredish.some((f) => !f.required))) {
            ctx.add({ testId: id, name, element: form, status: "manual", severity: "info", verification: "manual", message: `${requiredish.length} field(s) look mandatory but are not natively required, so they are probably validated by script; the page's scripts could not be run safely here. Leave them empty and press submit manually to confirm a message appears.` });
          } else if (empty.submitted && !feedback && requiredish.length) {
            ctx.add({ testId: id, name, element: form, status: "warning", severity: "medium", verification: "verified", message: `Empty form was not stopped: it tried to send ${sentWhat} (blocked by the extension) although ${requiredish.length} field(s) look mandatory, and no validation message appeared.`, actual: "empty submission allowed", expected: "validation messages and no submission", fix: "Validate mandatory fields (required attribute or script) before sending." });
          } else if (empty.submitted && feedback) {
            ctx.add({ testId: id, name, element: form, status: "warning", severity: "low", verification: "verified", message: `Validation feedback appeared (${how}), but the empty form still tried to send ${sentWhat} (blocked by the extension).`, actual: "messages shown, submission not stopped", expected: "submission stopped while fields are invalid", fix: "Stop the submission (preventDefault / return) when validation fails." });
          } else if (feedback) {
            ctx.add({ testId: id, name, element: form, status: "passed", severity: "info", verification: "verified", message: `Empty submission was stopped and validation feedback appeared: ${how}.`, evidence: { messages: sample } });
          } else if (!empty.submitted && requiredish.length) {
            ctx.add({ testId: id, name, element: form, status: "warning", severity: "medium", verification: "inferred", message: `Empty submission was ${empty.pageHandled ? "cancelled by the page's script" : "not sent"}, but no message, native validation bubble or invalid field state was detected although ${requiredish.length} field(s) look mandatory. Users may not understand why nothing happens.`, actual: "no detectable feedback", expected: "a visible message next to each empty mandatory field", fix: "Show a message near each invalid field (and set aria-invalid)." });
          }
          // Mandatory-looking fields without any feedback of their own
          if (feedback && !empty.submitted) {
            const shown = newMessages(baseline, form);
            const silent = requiredish.filter((f) => !feedbackFor(f, empty, shown));
            if (silent.length && silent.length < requiredish.length && shown.length > 1) {
              ctx.add({ testId: id, name, element: silent[0], status: "warning", severity: "low", verification: "inferred", message: `${silent.length} mandatory-looking field(s) got no message near them, while other fields did.`, evidence: { fields: silent.map((f) => h.cssPath(f)).slice(0, 10) }, fix: "Show a message for every invalid field (a single summary message is fine if it names the fields)." });
            }
          }
          // 2. invalid values
          const typed = fields.filter((f) => /^(email|url)$/.test(f.type) || looksLike(f).email);
          for (const f of typed) nativeSetValue(f, f.type === "url" ? "not a url" : "not-an-email");
          if (typed.length) {
            const inv = await submitTry();
            const shown = newMessages(baseline, form);
            for (const f of typed) {
              if (!feedbackFor(f, inv, shown)) {
                ctx.add({ testId: id, name, element: f, status: "warning", severity: "medium", verification: inv.submitted ? "verified" : "inferred", message: `Invalid value was not flagged: no invalid event, no aria-invalid/error class and no message near the field${inv.submitted ? "; the form tried to send it (blocked)" : ""}.`, actual: "invalid value accepted", expected: "field marked invalid with a message", evidence: { testValue: f.type === "url" ? "not a url" : "not-an-email" }, fix: "Validate the field and show a message next to it." });
              }
            }
          }
          const errorsBeforeValid = newMessages(baseline, form).map((m) => m.el).concat(visibleErrors(form));
          // 3. valid sample values
          for (const f of fields) {
            if (f.type === "checkbox") f.checked = f.required || f.checked;
            else if (f.type === "radio") {
              if (f.required) f.checked = true;
            } else if (f.localName === "select") {
              const idx = [...f.options].findIndex((o) => o.value && !o.disabled);
              f.selectedIndex = idx;
              f.dispatchEvent(new Event("change", { bubbles: true }));
            } else nativeSetValue(f, sampleValid(f));
          }
          await new Promise((r) => setTimeout(r, 300));
          for (const f of fields) {
            if (f.localName === "select" || /^(checkbox|radio|date|number|range)$/.test(f.type)) continue;
            if (f.value !== sampleValid(f)) {
              ctx.add({ testId: id, name, element: f, status: "warning", severity: "low", verification: "inferred", message: "Field did not keep the value that was set (input masking or a controlled component resetting it).", actual: "value changed after input", expected: "value retained", fix: "Verify typing into the field manually." });
            }
          }
          const beforeValidText = new Map(errorsBeforeValid.map((e) => [e, (e.textContent || "").trim()]));
          const valid = await submitTry();
          const stillErrors = [...new Set(errorsBeforeValid)].filter((e) => e.isConnected && h.isVisible(e) && (e.textContent || "").trim() === beforeValidText.get(e) && fields.some((f) => nearField(f, e)));
          if (valid.invalid.length) {
            ctx.add({ testId: id, name, element: valid.invalid[0], status: "warning", severity: "low", verification: "inferred", message: `${valid.invalid.length} field(s) rejected the extension's valid-looking sample values (may be stricter business rules).`, evidence: { fields: valid.invalid.map((f) => h.cssPath(f)) }, fix: "Check that valid input is accepted and that rules are explained." });
          } else if (valid.submitted) {
            ctx.add({ testId: id, name, element: form, status: "passed", severity: "info", verification: "verified", message: `With valid sample values the form passed client-side validation and tried to send ${valid.nativeSubmit ? "a native submission" : `${valid.requests.length} data request(s)`}; it was blocked by the extension, so nothing was sent. Server-side handling was NOT tested.` });
          } else if (pageHandlers && !valid.flagged.length) {
            ctx.add({ testId: id, name, element: form, status: "manual", severity: "info", verification: "manual", message: "With valid sample values no submission attempt was detected (the page may need values the extension cannot guess, a captcha, or sends data in a way that is not observable). Verify valid submission manually.", fix: "—" });
          }
          if (stillErrors.length) {
            ctx.add({ testId: id, name, element: stillErrors[0], status: "warning", severity: "medium", verification: "inferred", message: `${stillErrors.length} error message(s) remained visible after entering valid values.`, fix: "Clear error messages (and aria-invalid) once the value is corrected." });
          }
        } finally {
          form.removeEventListener("invalid", onInvalid, true);
          for (const { f, v, c, s } of saved) {
            if (f.type === "checkbox" || f.type === "radio") f.checked = c;
            else if (f.localName === "select") f.selectedIndex = s;
            else nativeSetValue(f, v);
          }
          if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true });
          else document.activeElement?.blur?.();
        }
      }
    } finally {
      release();
      net.stop();
    }
    if (guard.submits.length) ctx.limitation(`${guard.submits.length} native form submission(s) were cancelled during interactive form tests.`);
    if (net.list.length) ctx.limitation(`${net.list.length} outgoing data request(s) (POST/PUT/PATCH/DELETE, beacons, form.submit()) made by the page during interactive form tests were blocked; nothing was sent.`);
  }

  const SUBMIT_WORDS = /submit|send|save|sign ?up|register|log ?in|sign ?in|continue|next|apply|subscribe|order|book|request|contact|отправ|сохран|зарегистр|войти|вход|далее|продолж|заказ|подписа|оформ/i;
  const DANGER_WORDS = /delete|remove|cancel|reset|clear|logout|log out|sign out|pay|buy|purchase|checkout|удал|отмен|сброс|очист|выйти|оплат|купить/i;

  // The control a user would press to submit. Script-driven buttons (type=button) are only clicked while the page's
  // handlers are allowed to run, i.e. when outgoing data requests are blocked.
  function submitTrigger(form, pageHandlers) {
    if (!pageHandlers) return null;
    const subs = submitButtons(form).filter((b) => h.isVisible(b) && !b.disabled);
    const safe = (b) => !DANGER_WORDS.test(`${h.accessibleName(b).name} ${b.className} ${b.id}`);
    if (subs.length) return subs.find(safe) || null;
    return [...form.querySelectorAll('button[type=button], [role=button], a[href^="#"], a[href^="javascript:"], input[type=button]')].find((b) => h.isVisible(b) && !b.disabled && safe(b) && SUBMIT_WORDS.test(`${h.accessibleName(b).name} ${b.className} ${b.id}`)) || null;
  }

  function discoverGroups() {
    const groups = [];
    for (const form of document.forms) {
      if (h.isOwnNode(form)) continue;
      groups.push({ form, scope: form, fields: fieldsOf(form) });
    }
    const orphans = [...document.querySelectorAll("input, select, textarea")].filter((f) => !f.form && !h.isOwnNode(f) && !SKIP_TYPES.test((f.type || "").toLowerCase()));
    if (orphans.length) groups.push({ form: null, scope: document.body, fields: orphans });
    return groups;
  }

  QA.register("forms", {
    label: "Forms",
    custom: async (ctx) => {
      const groups = discoverGroups();
      ctx.extras.formCounts = { forms: document.forms.length, fieldsOutsideForms: groups.find((g) => !g.form)?.fields.length || 0 };
      if (!groups.length) {
        ctx.skip("forms.all", "Forms", "No forms or form fields on this page.");
        return [];
      }
      const tests = await staticChecks(ctx, groups);
      await constraintChecks(ctx, groups);
      await interactiveChecks(ctx, groups);
      if (document.forms.length) {
        ctx.manual("forms.server-response", "Submission outcome", "Whether a form actually saves data, sends email or shows a correct success/failure message can only be verified by submitting it in a test environment and checking the backend. A missing visible error after clicking submit does not prove success.", { severity: "low" });
        ctx.manual("forms.keyboard-submit", "Keyboard submission", "Fill the form using only the keyboard and press Enter in a text field; confirm it submits (or validates) the same way as clicking the button. Synthetic key events cannot trigger real submission, so this is not automated.");
      }
      return Object.values(tests).map((t) => ({ id: t.id, name: t.name, found: t.n }));
    },
  });
  QA.formHelpers = { looksLike, nativeSetValue, submitButtons, visibleErrors, hintText };
})();
