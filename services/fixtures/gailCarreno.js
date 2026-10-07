// Gail Carreno (ZIP 33186) compare, 2026-10-07 — the chat whose Excel export had 11 plan
// columns, 4 rows for 2 doctors, a "Dr. Full Name" row, a "both" med row, two
// Amlodipine/Benazepril rows and Xanax "Confirm in Sunfire". Shapes mirror the live UI:
// userMessages = what Yahoska typed; threadText = whole chat (Max's replies included);
// toolResults / providerLookups / drugs = session tool results; doctors/rememberedPlans =
// the previous export payload.

const HUMANA_054C = 'Humana Gold Plus (H1036-054C)';
const HUMANA_121 = 'Humana Gold Plus Diabetes & Heart (H1036-121)';
const HUMANA_305 = 'Humana Gold Plus Giveback (H1036-305)';
const UHC_001 = 'UHC MedicareMax FL-0028 (H5420-001)';
const UHC_014 = 'UHC MedicareMax Complete Care FL-30 (H5420-014)';
const DEVOTED_085 = 'Devoted C-SNP PLUS 085 (H1290-085)';
const DEVOTED_HMO = ['Devoted CORE 001 (H1290-001)', 'Devoted CORE 037 (H1290-037)'];

const userMessages = [
  'Gail Carreno, zip 33186, Dr.Coren Menendez PCP\nNatalia Rincon Neurologist\nYanelis Martin Endocrinologist\nRowan Jumean-Haddad Rheumatologist\nEli Haddad Cardiologist\nJerry Martel Gastrologist\nMeds: Levothyroxine\nAmlodipine/ Benazapril\nBupropian\nAmtriptylin\nRepatha\nXanax',
  'this is correct: Elie R Haddad, NPI 1740242361,   rawan jumean-haddad, , she does have chronic.. she was switched to UHC MedicareMax Complete Care FL-30 (HMO C-SNP) (H5420-14-0) for 2026',
  'both',
  'lets use this one',
  'compare H1036-121, H5420-014, H1290-085',
  'pls add this plan too H5420-001',
  'Check the grid again, H1036-121 does list the chronic conditions',
  'u put as non confirmed ont he grid',
  'she is',
];

const assistantMessages = [
  'Doctors × top plans for Gail Carreno, ZIP 33186\nExcluded: C-SNPs, D-SNPs.\nUHC MedicareMax FL-0028 HMO · H5420-001 · Aetna Medicare Select Care HMO · H1609-093 · Humana Gold Plus · H1036-054C\nDr. Coren Maria Menendez (PCP) · NPI 1386933810\t✅ In\t❔ not confirmed\t❌ Out\nCould not verify (over half the doctors unchecked, not ranked): HealthSun HealthAdvantage H5431-001, HealthSun MediMax H5431-006, HealthSun Health Advantage Plus H5431-017.\n1. Does Gail have Medicaid?\n2. Who is Rowan Jumean-Haddad? Is Eli Haddad = Elie R Haddad? Reply like "Rawan Jumean-Haddad = Dr. Full Name". Which meds should I price, Xanax or alprazolam?',
  'Rawan Jumean-Haddad still has no match (I also tried Dr. Rawan Haddad). Her current plan UHC Preferred Complete Care FL-0003 H1045-018 is not on the 2027 grid.',
  'Humana Gold Plus Giveback (H1036-305) also came back for Dr. Natalia Rincon.\n- ✅ In on both: Rincon Buendia, Martin, Rawan H Jumean, Elie R Haddad and Martel.\n- ❌ Out on both: Coren Maria Menendez (PCP).',
  'Yes, Dr. Natalia Rincon Buendia (Neurology, NPI 1902300361) is In on Humana — re-checked.\n❌ Out on both: Coren Maria Menendez (PCP).',
];

const threadText = userMessages
  .map((u, i) => [u, assistantMessages[i] || ''].join('\n'))
  .join('\n');

const net = (carrier, inPlans, outPlans, extra) => Object.assign(
  { carrier, inNetwork: inPlans.length > 0, plans: inPlans, outOfNetworkPlans: outPlans || [], status: inPlans.length ? 'in_network' : 'checked' },
  extra || {}
);

// Oldest first, like sessionToolResultsRef.
const providerLookups = [
  { doctorName: 'COREN MARIA MENENDEZ', requestedName: 'Coren Menendez', npi: '1386933810', networks: [
    net('Humana', [], [HUMANA_054C, HUMANA_121, HUMANA_305]), net('UnitedHealthcare', [UHC_001, UHC_014]),
    net('Devoted Health', [], [], { inNetwork: false, status: 'checked' }),
  ] },
  // First Rincon run: Humana timed out (carrier-level only) → not confirmed on Humana.
  { doctorName: 'NATALIA RINCON BUENDIA', requestedName: 'Natalia Rincon', npi: '1902300361', networks: [
    { carrier: 'Humana', inNetwork: false, plans: [], status: 'failed' }, net('UnitedHealthcare', [UHC_001, UHC_014]),
    { carrier: 'Devoted Health', inNetwork: true, status: 'checked' },
  ] },
  { doctorName: 'Rowan Jumean-Haddad', requestedName: 'Rowan Jumean-Haddad', networks: [] },
  { doctorName: 'ELIE R HADDAD', requestedName: 'Eli Haddad', npi: '1740242361', networks: [
    net('Humana', [HUMANA_054C, HUMANA_121]), net('UnitedHealthcare', [UHC_001, UHC_014]),
    net('Devoted Health', [], [DEVOTED_085], { inNetwork: false, status: 'checked' }),
  ] },
  { doctorName: 'Rawan Haddad', requestedName: 'Rawan Haddad', networks: [] },
  { doctorName: 'YANELIS MARTIN', requestedName: 'Yanelis Martin', npi: '1699977884', networks: [
    net('Humana', [HUMANA_054C, HUMANA_121]), net('UnitedHealthcare', [UHC_001, UHC_014]),
    // Live Devoted FHIR 2026-10-07: FL HMO D-SNP + FL PPO only — not FL HMO C-SNP.
    net('Devoted Health', [], [DEVOTED_085, ...DEVOTED_HMO], { inNetwork: true, status: 'checked' }),
  ] },
  { doctorName: 'JERRY MARTEL, M.P.H.', requestedName: 'Jerry Martel', npi: '1477755668', networks: [
    net('Humana', [HUMANA_054C, HUMANA_121]), net('UnitedHealthcare', [UHC_001, UHC_014]),
    net('Devoted Health', [], [DEVOTED_085, ...DEVOTED_HMO], { inNetwork: true, status: 'checked' }),
  ] },
  { doctorName: 'RAWAN H JUMEAN', requestedName: 'rawan jumean-haddad', npi: '1184715435', networks: [
    net('Humana', [HUMANA_054C, HUMANA_121]), net('UnitedHealthcare', [UHC_001, UHC_014]),
    net('Devoted Health', [], [DEVOTED_085], { inNetwork: false, status: 'checked' }),
  ] },
  // Re-run: Humana now answers plan-level In; Devoted by network (FL HMO yes, FL HMO C-SNP no).
  { doctorName: 'NATALIA RINCON BUENDIA', requestedName: 'Natalia Rincon Buendia', npi: '1902300361', networks: [
    net('Humana', [HUMANA_054C, HUMANA_121, HUMANA_305]), net('UnitedHealthcare', [UHC_001, UHC_014]),
    net('Devoted Health', DEVOTED_HMO, [DEVOTED_085]),
  ] },
];

const v = (tier, costShare) => ({ verified: true, tier, coverage: 'covered', costShare, source: 'medicare_gov' });
const unv = () => ({ verified: false, tier: null });
const nc = (unsure) => ({ verified: true, tier: null, coverage: 'not_covered', unsure: Boolean(unsure), source: 'medicare_gov' });

const drugs = [
  { name: 'Levothyroxine Sodium', byPlanId: { 'H5420-001': v(1, '$0'), 'H5420-014': v(1, '$0'), 'H1036-121': v(1, '$0'), 'H1290-085': v(1, '$0') } },
  { name: 'Amlodipine/Benazepril', byPlanId: { 'H5420-001': v(1, '$0'), 'H5420-014': v(1, '$0'), 'H1036-121': v(6, '$0'), 'H1290-085': unv() } },
  { name: 'Bupropion HCL', byPlanId: { 'H5420-001': v(2, '$0'), 'H5420-014': v(2, '$0'), 'H1036-121': v(2, '$0'), 'H1290-085': v(2, '$0') } },
  { name: 'Amitriptyline HCL', byPlanId: { 'H5420-001': v(3, '$25'), 'H5420-014': v(3, '$0'), 'H1036-121': v(4, '50%'), 'H1290-085': v(3, '15%') } },
  { name: 'Repatha', byPlanId: { 'H5420-001': v(3, '$25'), 'H5420-014': v(3, '$0'), 'H1036-121': v(3, '8%'), 'H1290-085': v(3, '15%') } },
  // Not covered on every plan and "Xanax" was not a known brand → toExportDrug marked it unsure.
  { name: 'Xanax', byPlanId: { 'H5420-001': nc(true), 'H5420-014': nc(true), 'H1036-121': nc(true), 'H1290-085': nc(true) } },
  { name: 'Alprazolam', byPlanId: { 'H5420-001': v(2, '$0'), 'H5420-014': v(2, '$0'), 'H1036-121': v(3, '8%'), 'H1290-085': v(2, '$0') } },
  // The catalog's own name for the same drug, from a later lookup.
  { name: 'Amlodipine Besy-Benazepril HCL', byPlanId: { 'H5420-001': unv(), 'H5420-014': unv(), 'H1036-121': unv(), 'H1290-085': v(1, '$0') } },
  // "2. both" answered Max's meds question and became a lookup.
  { name: 'both', byPlanId: { 'H5420-001': unv(), 'H5420-014': unv(), 'H1036-121': unv(), 'H1290-085': unv() } },
];

// Previous export payload (lastComparisonExportRef) — carries the stale rows.
const rememberedDoctors = [
  { name: 'Dr. Coren Menendez', byPlanId: { 'H1036-054C': 'Out of network', 'H5420-001': 'In network' } },
  { name: 'Dr. Natalia Rincon', byPlanId: { 'H5420-001': 'In network' } },
  { name: 'Dr. Rowan Jumean-Haddad', byPlanId: {} },
  { name: 'Dr. Eli Haddad', byPlanId: { 'H5420-001': 'In network' } },
  { name: 'Dr. Rawan Haddad', byPlanId: {} },
  { name: 'Dr. Full Name', byPlanId: {} },
];
const rememberedPlanIds = ['H1036-054C', 'H5420-001', 'H5420-014', 'H1609-093', 'H5431-001', 'H5431-006', 'H5431-017', 'H1045-018', 'H1036-305', 'H1036-121', 'H1290-085'];

module.exports = {
  userMessages,
  assistantMessages,
  threadText,
  providerLookups,
  drugs,
  rememberedDoctors,
  rememberedPlanIds,
};
