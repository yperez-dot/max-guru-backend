# Medical group carrier rules (Medicare Advantage)

Some medical groups take only certain Medicare Advantage carriers for their primary care doctors, even when a
carrier's online directory still lists the doctor. These rules come from Yahoska (THEI) and win over a directory "In".
Max applies them in the doctor × plan table (services/medicalGroupRules.js). A plan the group does not take shows
❌ Not in network, with a note naming the group rule.

## Baptist Health Medical Group (BHMG), primary care

**2027 (AEP default):** Yahoska added a **Baptist PCPs** row to the live THEI 2027 Plan Comparison Grid, tab **Hospitals x Carrier** (gid 369609513). That row is Max's source of truth. BHMG / Baptist primary care is **Yes** only for **FL BLUE** and **MedicareMax**. Aetna (HMO and PPO), Humana, HealthSun, and every other column is **No**. Do not answer a Baptist *hospital* question from this row — use **Baptist Hospital**.

**2026 only:** the older Yahoska rule (2026-10-17) still applies: Aetna but not Aetna Medicare HMO, HealthSpring, Florida Blue, Preferred Care Network (UHC MedicareMax H5420).

BHMG specialists (endocrinology, surgery, spine and so on) are NOT covered by this rule. Check them in the carrier directories as usual.

## University of Miami primary care (UM PCP), 2027

Yahoska added a **UM PCP** row on the same Hospitals x Carrier tab. UM / UHealth / UMMG **primary care** is **Yes** only for **HealthSun** and **Simply**. Humana is **No** for UM PCP and **Yes** for the **University of Miami** *hospital* row — do not confuse PCP with hospital.

Carriers the grid has no column for (Prominence, Freedom, Optimum) stay on UHealth's Insurance Plans Accepted page (`data/hospitals-x-carrier-2027.json` umSiteSupplement), labeled as from UM's site. The grid wins on every overlapping carrier.

This overlay is **2027 only**. 2026 UM doctors stay on the 2026 HOSPITALS list / directories.

How Max spots a BHMG primary care doctor:
- the agent writes "Baptist Medical Group", "Baptist Health Medical Group" or "BHMG" next to the doctor's name, and
- the NPI taxonomy is primary care, or the agent calls the doctor PCP / primary.

Known BHMG PCPs:
- Nathalie Regalado, Internal Medicine, NPI 1467795633 (13101 S Dixie Hwy Ste 400, Pinecrest). She was showing In on Humana, which is wrong.
