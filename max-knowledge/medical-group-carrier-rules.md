# Medical group carrier rules (Medicare Advantage)

Some medical groups take only certain Medicare Advantage carriers for their primary care doctors, even when a
carrier's online directory still lists the doctor. These rules come from Yahoska (THEI) and win over a directory "In".
Max applies them in the doctor × plan table (services/medicalGroupRules.js). A plan the group does not take shows
❌ Not in network, with a note naming the group rule.

## Baptist Health Medical Group (BHMG), primary care

Rule from Yahoska, 2026-10-17.

BHMG primary care doctors (Family Medicine, Internal Medicine, General Practice, Geriatrics, or the agent says PCP / primary)
take these Medicare Advantage carriers only:

- Aetna, but NOT Aetna Medicare HMO plans
- HealthSpring (Cigna has no 2027 Florida MA plans, so this rarely matters for 2027)
- Florida Blue
- Preferred Care Network, which is UHC MedicareMax (H5420 plans)

Every other carrier is out for BHMG primary care: Humana, Doctors HealthCare Plans, UHC plans other than
MedicareMax, Devoted, Solis, CarePlus, Simply, Wellcare, HealthSun and so on.

BHMG specialists (endocrinology, surgery, spine and so on) are NOT covered by this rule. Check them in the carrier directories as usual.

How Max spots a BHMG primary care doctor:
- the agent writes "Baptist Medical Group", "Baptist Health Medical Group" or "BHMG" next to the doctor's name, and
- the NPI taxonomy is primary care, or the agent calls the doctor PCP / primary.

Known BHMG PCPs:
- Nathalie Regalado, Internal Medicine, NPI 1467795633 (13101 S Dixie Hwy Ste 400, Pinecrest). She was showing In on Humana, which is wrong.
