import { DecimalCase } from '../src/models/decimal_fixture/models.js';

const amount: string = new DecimalCase().getAmount();
const large: string | null = new DecimalCase().getLargeValue();
new DecimalCase().setAmount(amount).setLargeValue(large);

// @ts-expect-error A generated decimal setter accepts exact text, not binary64.
new DecimalCase().setAmount(48.045);
// @ts-expect-error A generated decimal setter accepts exact text, not binary64.
new DecimalCase().setLargeValue(9007199254740992);
