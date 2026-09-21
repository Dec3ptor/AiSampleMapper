/* plan.js — stockpile volumes, sampling density rules and QA/QC requirements.
 *
 * Nothing here is hard-wired to a particular guideline. The defaults below are
 * a common starting point only; the intended workflow is that the user sets the
 * rule from whatever governs the job -- the receiving facility's waste
 * acceptance criteria, the consent conditions, or the applicable guidance
 * (MfE Contaminated Land Management Guidelines No. 5, the WasteMINZ Technical
 * Guidelines for Disposal to Land). Every rule is stored with the project and
 * printed on the exports so the basis travels with the numbers.
 */
(function (ASM) {
  'use strict';

  /* Ratio of (footprint area x mean height) that is actually material.
   * A pile is rarely a prism: these are the usual idealised forms. */
  var FORMS = [
    { id: 'flat', name: 'Flat-topped / windrow', factor: 0.70, hint: 'Batter slopes, level top' },
    { id: 'domed', name: 'Domed', factor: 0.50, hint: 'Rounded, tipped and spread' },
    { id: 'conical', name: 'Conical', factor: 0.33, hint: 'Single tipping point' },
    { id: 'prism', name: 'Level / bunded', factor: 1.00, hint: 'Vertical sides, e.g. in a bay' },
    { id: 'custom', name: 'Custom factor', factor: 0.60, hint: 'Enter your own' }
  ];

  function formById(id) {
    for (var i = 0; i < FORMS.length; i++) if (FORMS[i].id === id) return FORMS[i];
    return FORMS[0];
  }

  var SAMPLE_TYPES = [
    { id: 'discrete', name: 'Discrete', short: 'D', color: '#FFD21E', desc: 'Single point, single depth' },
    { id: 'composite', name: 'Composite', short: 'C', color: '#22D3EE', desc: 'Increments combined into one sample' },
    { id: 'duplicate', name: 'Field duplicate', short: 'QA', color: '#FF4FC3', desc: 'Co-located QA split' },
    { id: 'split', name: 'Inter-lab split', short: 'IL', color: '#B58BFF', desc: 'Second laboratory check' },
    { id: 'control', name: 'Background / control', short: 'B', color: '#FFFFFF', desc: 'Off-pile reference' }
  ];

  function typeById(id) {
    for (var i = 0; i < SAMPLE_TYPES.length; i++) if (SAMPLE_TYPES[i].id === id) return SAMPLE_TYPES[i];
    return SAMPLE_TYPES[0];
  }

  /* A composite is one laboratory sample built from several increments. When
   * the increments have been marked on the photo their count is the truth;
   * otherwise fall back to the number typed on the sample. */
  function incrementCount(sample) {
    if (!sample) return 0;
    if (sample.incPts && sample.incPts.length) return sample.incPts.length;
    return sample.type === 'composite' ? (parseInt(sample.increments, 10) || 0) : 1;
  }

  function isComposite(sample) { return !!sample && sample.type === 'composite'; }

  function defaultRule() {
    return {
      mode: 'rate',
      rate: { perCubic: 250, min: 3 },
      banded: {
        bands: [
          { upTo: 50, samples: 2 },
          { upTo: 100, samples: 3 },
          { upTo: 250, samples: 4 },
          { upTo: 500, samples: 5 },
          { upTo: 1000, samples: 7 }
        ],
        perExtra: 500
      },
      fixed: 5
    };
  }

  function defaultQA() {
    return { dupEvery: 20, splitEvery: 0, blanks: 0 };
  }

  /** Footprint area (m2) and mean height (m) -> in-situ volume (m3). */
  function volumeOf(pile, areaM2) {
    if (pile.volumeOverride != null && isFinite(pile.volumeOverride) && pile.volumeOverride > 0) {
      return pile.volumeOverride;
    }
    var h = parseFloat(pile.heightM);
    if (!isFinite(h) || h <= 0 || !isFinite(areaM2)) return null;
    var factor = pile.formId === 'custom'
      ? (isFinite(parseFloat(pile.customFactor)) ? parseFloat(pile.customFactor) : 0.6)
      : formById(pile.formId).factor;
    return areaM2 * h * factor;
  }

  /** Sample locations required for a volume under the active rule. */
  function requiredFor(rule, volume) {
    if (volume == null || !isFinite(volume) || volume <= 0) return null;
    if (rule.mode === 'fixed') return Math.max(1, Math.round(rule.fixed));

    if (rule.mode === 'banded') {
      var bands = (rule.banded.bands || []).slice().sort(function (a, b) { return a.upTo - b.upTo; });
      for (var i = 0; i < bands.length; i++) {
        if (volume <= bands[i].upTo) return Math.max(1, Math.round(bands[i].samples));
      }
      var last = bands[bands.length - 1];
      if (!last) return 1;
      var per = rule.banded.perExtra > 0 ? rule.banded.perExtra : 500;
      return Math.max(1, Math.round(last.samples) + Math.ceil((volume - last.upTo) / per));
    }

    var perCubic = rule.rate.perCubic > 0 ? rule.rate.perCubic : 250;
    return Math.max(Math.round(rule.rate.min) || 1, Math.ceil(volume / perCubic));
  }

  /** One-line statement of the active rule, carried onto every export. */
  function describeRule(rule) {
    if (rule.mode === 'fixed') return 'Fixed ' + rule.fixed + ' locations per stockpile';
    if (rule.mode === 'banded') {
      var bands = (rule.banded.bands || []).slice().sort(function (a, b) { return a.upTo - b.upTo; });
      var parts = bands.map(function (b) { return '≤' + b.upTo + ' m³: ' + b.samples; });
      var last = bands[bands.length - 1];
      if (last) parts.push('>' + last.upTo + ' m³: ' + last.samples + ' + 1 per ' + rule.banded.perExtra + ' m³');
      return 'Banded — ' + parts.join('; ');
    }
    return '1 location per ' + rule.rate.perCubic + ' m³ (minimum ' + rule.rate.min + ')';
  }

  /** QA/QC additions. Duplicates are co-located, so they add lab samples only. */
  function qaFor(qa, primaryCount) {
    var dup = qa.dupEvery > 0 ? Math.ceil(primaryCount / qa.dupEvery) : 0;
    var split = qa.splitEvery > 0 ? Math.ceil(primaryCount / qa.splitEvery) : 0;
    var blanks = Math.max(0, Math.round(qa.blanks) || 0);
    return { duplicates: dup, splits: split, blanks: blanks, total: dup + split + blanks };
  }

  function describeQA(qa) {
    var bits = [];
    bits.push(qa.dupEvery > 0 ? '1 field duplicate per ' + qa.dupEvery + ' primary samples' : 'no field duplicates');
    if (qa.splitEvery > 0) bits.push('1 inter-lab split per ' + qa.splitEvery);
    if (qa.blanks > 0) bits.push(qa.blanks + ' field blank' + (qa.blanks === 1 ? '' : 's'));
    return bits.join('; ');
  }

  ASM.plan = {
    FORMS: FORMS,
    SAMPLE_TYPES: SAMPLE_TYPES,
    formById: formById,
    typeById: typeById,
    incrementCount: incrementCount,
    isComposite: isComposite,
    defaultRule: defaultRule,
    defaultQA: defaultQA,
    volumeOf: volumeOf,
    requiredFor: requiredFor,
    describeRule: describeRule,
    qaFor: qaFor,
    describeQA: describeQA
  };
})(window.ASM = window.ASM || {});
