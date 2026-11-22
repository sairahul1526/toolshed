/**
 * The fonts that ship with the module, and which characters each file can draw.
 * Generated from the files in ../fonts (a test checks the two still agree). Each family is split
 * by script so a render loads only the files its text needs.
 */

export const FAMILIES = [
  {
    id: 'inter',
    name: 'Inter',
    kind: 'sans',
    faces: [
      {
        weight: 400,
        files: [
          { path: 'inter/inter-400-latin.ttf', ranges: '0,20-7e,a0-ac,ae-ff,131,152-153,2bb-2bc,2c6,2da,2dc,300-301,303-304,308-309,323,2002,2009,200b,2013-2014,2018-201a,201c-201e,2022,2026,2032-2033,2039-203a,2044,20ac,2122,2191,2193,2212,feff' },
          { path: 'inter/inter-400-latin-ext.ttf', ranges: '0,20,41,a0,c4,100-130,132-148,14a-151,154-1c3,1c5-254,256-27b,27e-284,286-290,292-2a4,2a6-2ba,2bc-2c5,2c7-2cc,2ce-2d7,2dd-301,303-304,308-309,323,1d00,1d0d,1d1b,1d43,1d47-1d49,1d4d,1d4f-1d50,1d52,1d56-1d58,1d5b,1d62-1d65,1d9c,1da0,1dbb,1dbf,1e00-1e9b,1e9d-1e9f,1ef2-1eff,2020,20a0-20ab,20ad-20af,20b1-20b5,20b8-20ba,20bc-20bf,2113,2c7c,2c7f,a7ff' },
          { path: 'inter/inter-400-cyrillic.ttf', ranges: '0,20,41,a0,c4,301,400-45f,490-491,4b0-4b1,2116' },
          { path: 'inter/inter-400-cyrillic-ext.ttf', ranges: '0,20,41,a0,c4,460-479,480-48f,492-49d,4a0-4af,4b2-4ff,52f,20b4,2dff,a69f' },
          { path: 'inter/inter-400-greek.ttf', ranges: '0,20,41,a0,c4,374-376,37a-37f,384-38a,38c,38e-3a1,3a3-3d7,3dc-3dd,3f0-3f6,3f9-3fa,3fc-3ff' },
          { path: 'inter/inter-400-greek-ext.ttf', ranges: '0,20,41,a0,c4,1f00-1f15,1f18-1f1d,1f20-1f45,1f48-1f4d,1f50-1f57,1f59,1f5b,1f5d,1f5f-1f7d,1f80-1fb4,1fb6-1fc4,1fc6-1fd3,1fd6-1fdb,1fdd-1fef,1ff2-1ff4,1ff6-1ffe' },
          { path: 'inter/inter-400-vietnamese.ttf', ranges: '0,20,41,a0,c4,102-103,110-111,128-129,168-169,1a0-1a1,1af-1b0,300-301,303-304,308-309,323,1ea0-1ef9,20ab' },
        ],
      },
      {
        weight: 600,
        files: [
          { path: 'inter/inter-600-latin.ttf', ranges: '0,20-7e,a0-ac,ae-ff,131,152-153,2bb-2bc,2c6,2da,2dc,300-301,303-304,308-309,323,2002,2009,200b,2013-2014,2018-201a,201c-201e,2022,2026,2032-2033,2039-203a,2044,20ac,2122,2191,2193,2212,feff' },
          { path: 'inter/inter-600-latin-ext.ttf', ranges: '0,20,41,a0,c4,100-130,132-148,14a-151,154-1c3,1c5-254,256-27b,27e-284,286-290,292-2a4,2a6-2ba,2bc-2c5,2c7-2cc,2ce-2d7,2dd-301,303-304,308-309,323,1d00,1d0d,1d1b,1d43,1d47-1d49,1d4d,1d4f-1d50,1d52,1d56-1d58,1d5b,1d62-1d65,1d9c,1da0,1dbb,1dbf,1e00-1e9b,1e9d-1e9f,1ef2-1eff,2020,20a0-20ab,20ad-20af,20b1-20b5,20b8-20ba,20bc-20bf,2113,2c7c,2c7f,a7ff' },
          { path: 'inter/inter-600-cyrillic.ttf', ranges: '0,20,41,a0,c4,301,400-45f,490-491,4b0-4b1,2116' },
          { path: 'inter/inter-600-cyrillic-ext.ttf', ranges: '0,20,41,a0,c4,460-479,480-48f,492-49d,4a0-4af,4b2-4ff,52f,20b4,2dff,a69f' },
          { path: 'inter/inter-600-greek.ttf', ranges: '0,20,41,a0,c4,374-376,37a-37f,384-38a,38c,38e-3a1,3a3-3d7,3dc-3dd,3f0-3f6,3f9-3fa,3fc-3ff' },
          { path: 'inter/inter-600-greek-ext.ttf', ranges: '0,20,41,a0,c4,1f00-1f15,1f18-1f1d,1f20-1f45,1f48-1f4d,1f50-1f57,1f59,1f5b,1f5d,1f5f-1f7d,1f80-1fb4,1fb6-1fc4,1fc6-1fd3,1fd6-1fdb,1fdd-1fef,1ff2-1ff4,1ff6-1ffe' },
          { path: 'inter/inter-600-vietnamese.ttf', ranges: '0,20,41,a0,c4,102-103,110-111,128-129,168-169,1a0-1a1,1af-1b0,300-301,303-304,308-309,323,1ea0-1ef9,20ab' },
        ],
      },
      {
        weight: 800,
        files: [
          { path: 'inter/inter-800-latin.ttf', ranges: '0,20-7e,a0-ac,ae-ff,131,152-153,2bb-2bc,2c6,2da,2dc,300-301,303-304,308-309,323,2002,2009,200b,2013-2014,2018-201a,201c-201e,2022,2026,2032-2033,2039-203a,2044,20ac,2122,2191,2193,2212,feff' },
          { path: 'inter/inter-800-latin-ext.ttf', ranges: '0,20,41,a0,c4,100-130,132-148,14a-151,154-1c3,1c5-254,256-27b,27e-284,286-290,292-2a4,2a6-2ba,2bc-2c5,2c7-2cc,2ce-2d7,2dd-301,303-304,308-309,323,1d00,1d0d,1d1b,1d43,1d47-1d49,1d4d,1d4f-1d50,1d52,1d56-1d58,1d5b,1d62-1d65,1d9c,1da0,1dbb,1dbf,1e00-1e9b,1e9d-1e9f,1ef2-1eff,2020,20a0-20ab,20ad-20af,20b1-20b5,20b8-20ba,20bc-20bf,2113,2c7c,2c7f,a7ff' },
          { path: 'inter/inter-800-cyrillic.ttf', ranges: '0,20,41,a0,c4,301,400-45f,490-491,4b0-4b1,2116' },
          { path: 'inter/inter-800-cyrillic-ext.ttf', ranges: '0,20,41,a0,c4,460-479,480-48f,492-49d,4a0-4af,4b2-4ff,52f,20b4,2dff,a69f' },
          { path: 'inter/inter-800-greek.ttf', ranges: '0,20,41,a0,c4,374-376,37a-37f,384-38a,38c,38e-3a1,3a3-3d7,3dc-3dd,3f0-3f6,3f9-3fa,3fc-3ff' },
          { path: 'inter/inter-800-greek-ext.ttf', ranges: '0,20,41,a0,c4,1f00-1f15,1f18-1f1d,1f20-1f45,1f48-1f4d,1f50-1f57,1f59,1f5b,1f5d,1f5f-1f7d,1f80-1fb4,1fb6-1fc4,1fc6-1fd3,1fd6-1fdb,1fdd-1fef,1ff2-1ff4,1ff6-1ffe' },
          { path: 'inter/inter-800-vietnamese.ttf', ranges: '0,20,41,a0,c4,102-103,110-111,128-129,168-169,1a0-1a1,1af-1b0,300-301,303-304,308-309,323,1ea0-1ef9,20ab' },
        ],
      },
    ],
  },
  {
    id: 'libre-baskerville',
    name: 'Libre Baskerville',
    kind: 'serif',
    faces: [
      {
        weight: 400,
        files: [
          { path: 'libre-baskerville/libre-baskerville-400-latin.ttf', ranges: '20-7e,a0-ac,ae-ff,102,131,152-153,2bc,2c6,2da,2dc,300-301,303-304,308,323,2013-2014,2018-201a,201c-201e,2022,2026,2039-203a,2044,20ac,2122,2212,2215' },
          { path: 'libre-baskerville/libre-baskerville-400-latin-ext.ttf', ranges: '20,41,a0,c1,100-130,132-148,14a-151,154-17e,180-181,186-18a,18e-193,196-19a,19d,1a4-1a5,1a9,1ac-1ae,1b2-1b6,1c4-1ed,1f0-1f5,1f8-21b,21e-21f,226-233,237,23a-23e,241-24f,251,253-254,256-257,259,25b,260,265-266,268-269,26b,272,27d-27e,283,288-289,28b-28c,294-295,2bc,2be-2bf,2c7,2dd,300-301,303-304,308,323,1d7d,1e00-1e9a,1e9e,1ef2-1ef5,1ef8-1ef9,2020,20a4,20b5,2c60-2c66,2c6d,2c72-2c73,a740-a741,a78b-a78d,a792-a793,a7aa' },
        ],
      },
      {
        weight: 700,
        files: [
          { path: 'libre-baskerville/libre-baskerville-700-latin.ttf', ranges: '20-7e,a0-ac,ae-ff,102,131,152-153,2bc,2c6,2da,2dc,300-301,303-304,308,323,2013-2014,2018-201a,201c-201e,2022,2026,2039-203a,2044,20ac,2122,2212,2215' },
          { path: 'libre-baskerville/libre-baskerville-700-latin-ext.ttf', ranges: '20,41,a0,c1,100-130,132-148,14a-151,154-17e,180-181,186-18a,18e-193,196-19a,19d,1a4-1a5,1a9,1ac-1ae,1b2-1b6,1c4-1ed,1f0-1f5,1f8-21b,21e-21f,226-233,237,23a-23e,241-24f,251,253-254,256-257,259,25b,260,265-266,268-269,26b,272,27d-27e,283,288-289,28b-28c,294-295,2bc,2be-2bf,2c7,2dd,300-301,303-304,308,323,1d7d,1e00-1e9a,1e9e,1ef2-1ef5,1ef8-1ef9,2020,20a4,20b5,2c60-2c66,2c6d,2c72-2c73,a740-a741,a78b-a78d,a792-a793,a7aa' },
        ],
      },
    ],
  },
  {
    id: 'jetbrains-mono',
    name: 'JetBrains Mono',
    kind: 'mono',
    faces: [
      {
        weight: 500,
        files: [
          { path: 'jetbrains-mono/jetbrains-mono-500-latin.ttf', ranges: 'd,20-7e,a0-ff,102,131,152-153,2bc,2c6,2da,2dc,300-301,303-304,308-309,323,2013-2014,2018-201a,201c-201e,2022,2026,2032-2033,2039-203a,2044,20ac,2122,2191,2193,2212,2215,feff' },
          { path: 'jetbrains-mono/jetbrains-mono-500-latin-ext.ttf', ranges: 'd,20,41,a0,c1,100-130,134-151,154-17f,18f,192,1a0-1a1,1af-1b0,1cd-1ce,1e6-1e7,1ea-1eb,1f4-1f5,1fc-1ff,218-21b,232-233,237,259,2b9-2ba,2bc,2c7,2c9,2dd,2f3,2f7,300-301,303-304,308-309,323,1e80-1e85,1e9e,1ef2-1ef9,2020,20ab,20ae,20bd,20bf,2113' },
          { path: 'jetbrains-mono/jetbrains-mono-500-cyrillic.ttf', ranges: 'd,20,41,a0,c1,102,301,401-40c,40e-44f,451-45c,45e-45f,490-491,2116' },
          { path: 'jetbrains-mono/jetbrains-mono-500-greek.ttf', ranges: 'd,20,41,a0,c1,102,374-375,37e,384-38a,38c,38e-3a1,3a3-3cf,3d7' },
        ],
      },
    ],
  },
];

/** One-colour emoji, used for any emoji a text font does not have. */
export const EMOJI = { path: 'noto-emoji/noto-emoji-400.ttf', ranges: '0,d,20,23,2a,30-39,a9,ae,200d,203c,2049,20e3,2122,2139,2194-2199,21a9-21aa,231a-231b,2328,23cf,23e9-23f3,23f8-23fa,24c2,25aa-25ab,25b6,25c0,25fb-25fe,2600-2604,260e,2611,2614-2615,2618,261d,2620,2622-2623,2626,262a,262e-262f,2638-263a,2640,2642,2648-2653,265f-2660,2663,2665-2666,2668,267b,267e-267f,2692-2697,2699,269b-269c,26a0-26a1,26a7,26aa-26ab,26b0-26b1,26bd-26be,26c4-26c5,26c8,26ce-26cf,26d1,26d3-26d4,26e9-26ea,26f0-26f5,26f7-26fa,26fd,2702,2705,2708-270d,270f,2712,2714,2716,271d,2721,2728,2733-2734,2744,2747,274c,274e,2753-2755,2757,2763-2764,2795-2797,27a1,27b0,27bf,2934-2935,2b05-2b07,2b1b-2b1c,2b50,2b55,3030,303d,3297,3299,fe0e-fe0f,1f004,1f0cf,1f170-1f171,1f17e-1f17f,1f18e,1f191-1f19a,1f1e6-1f1ff,1f201-1f202,1f21a,1f22f,1f232-1f23a,1f250-1f251,1f300-1f321,1f324-1f393,1f396-1f397,1f399-1f39b,1f39e-1f3f0,1f3f3-1f3f5,1f3f7-1f4fd,1f4ff-1f53d,1f549-1f54e,1f550-1f567,1f56f-1f570,1f573-1f57a,1f587,1f58a-1f58d,1f590,1f595-1f596,1f5a4-1f5a5,1f5a8,1f5b1-1f5b2,1f5bc,1f5c2-1f5c4,1f5d1-1f5d3,1f5dc-1f5de,1f5e1,1f5e3,1f5e8,1f5ef,1f5f3,1f5fa-1f64f,1f680-1f6c5,1f6cb-1f6d2,1f6d5-1f6d9,1f6dc-1f6e5,1f6e9,1f6eb-1f6ec,1f6f0,1f6f3-1f6fc,1f7e0-1f7eb,1f7f0,1f90c-1f93a,1f93c-1f945,1f947-1f9ff,1fa70-1fa7c,1fa80-1fac6,1fac8,1facc-1fadd,1fadf-1faeb,1faef-1fafa,e0062-e0063,e0065,e0067,e006c,e006e,e0073-e0074,e0077,e007f' };

export const DEFAULT_FAMILY = 'inter';
