// config.js — Subspecialty configuration
// This is the only file that differs between extension variants.
// Loaded as a content script (before content.js) and via <script> in popup.html.

const SUBSPECIALTY = {
  name: 'Spine',
  id:   'spine',

  defaultServerUrl: 'http://localhost:8888',
  viewerParams:     '',

  regionKeywords: {
    lumbar:   ['lumbar', 'lumbosacral', 'l-spine', 'l spine', 'l1', 'l2', 'l3', 'l4', 'l5', 's1', 'sacrum', 'sacral', 'coccyx', 'scoliosis', 'spine'],
    cervical: ['cervical', 'c-spine', 'c spine', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'myelogram'],
    thoracic: ['thoracic', 't-spine', 't spine', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10', 't11', 't12'],
  },

  modalityCodes: {
    xr: ['XR', 'CR', 'DX', 'RF'],
    ct: ['CT'],
    mr: ['MR', 'MRI'],
  },

  hideModalityFilters: false,

  regionCheckboxes: [
    { id: 'filterSpine', label: 'Spine only', regions: ['lumbar', 'cervical', 'thoracic'] },
  ],
};
