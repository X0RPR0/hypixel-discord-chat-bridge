class DiscountEngine {
  constructor(db) {
    this.db = db;
  }

  getNow() {
    return Date.now();
  }

  specificity(rule, category, carryType, tier) {
    if (rule.scope === "carry") {
      const typeMatch = String(rule.carry_type || "").toLowerCase() === String(carryType || "").toLowerCase();
      const tierMatch = !rule.tier || String(rule.tier).toLowerCase() === String(tier || "").toLowerCase();
      return typeMatch && tierMatch ? 3 : -1;
    }

    if (rule.scope === "category") {
      return String(rule.category || "").toLowerCase() === String(category || "").toLowerCase() ? 2 : -1;
    }

    if (rule.scope === "global") {
      return 1;
    }

    return -1;
  }

  resolveScopeDiscount({ category, carryType, tier, amount }) {
    const db = this.db.getConnection();
    const now = this.getNow();

    const timedRules = db
      .prepare(
        `SELECT *
         FROM discount_rules
         WHERE active = 1
           AND kind = 'timed'
           AND starts_at <= ?
           AND ends_at >= ?`
      )
      .all(now, now);

    const validTimed = timedRules
      .map((rule) => ({ rule, specificity: this.specificity(rule, category, carryType, tier) }))
      .filter((item) => item.specificity > 0)
      .sort((a, b) => {
        if (b.specificity !== a.specificity) return b.specificity - a.specificity;
        if (Number(b.rule.percentage) !== Number(a.rule.percentage)) return Number(b.rule.percentage) - Number(a.rule.percentage);
        return Number(b.rule.id) - Number(a.rule.id);
      });

    if (validTimed.length > 0) {
      return {
        source: "timed",
        scope: validTimed[0].rule.scope,
        percentage: Number(validTimed[0].rule.percentage),
        ruleId: validTimed[0].rule.id,
        endsAt: Number(validTimed[0].rule.ends_at)
      };
    }

    const staticRules = db
      .prepare(
        `SELECT *
         FROM discount_rules
         WHERE active = 1
           AND kind = 'static'
           AND scope = 'global'
           AND min_amount IS NOT NULL
           AND min_amount <= ?`
      )
      .all(amount);

    if (staticRules.length === 0) {
      return null;
    }

    staticRules.sort((a, b) => {
      if (Number(b.min_amount) !== Number(a.min_amount)) return Number(b.min_amount) - Number(a.min_amount);
      return Number(b.percentage) - Number(a.percentage);
    });

    return {
      source: "static",
      scope: "global",
      percentage: Number(staticRules[0].percentage),
      ruleId: staticRules[0].id,
      minAmount: Number(staticRules[0].min_amount)
    };
  }

  resolveBulkDiscount({ category, carryType, tier, amount }) {
    const db = this.db.getConnection();
    const rules = db
      .prepare(
        `SELECT *
         FROM discount_rules
         WHERE active = 1
           AND kind = 'bulk'
           AND min_amount IS NOT NULL
           AND min_amount <= ?`
      )
      .all(amount);

    if (rules.length === 0) {
      return null;
    }

    const valid = rules
      .map((rule) => ({ rule, specificity: this.specificity(rule, category, carryType, tier) }))
      .filter((item) => item.specificity >= 2)
      .sort((a, b) => {
        if (b.specificity !== a.specificity) return b.specificity - a.specificity;
        if (Number(b.rule.percentage) !== Number(a.rule.percentage)) return Number(b.rule.percentage) - Number(a.rule.percentage);
        if (Number(b.rule.min_amount) !== Number(a.rule.min_amount)) return Number(b.rule.min_amount) - Number(a.rule.min_amount);
        return Number(b.rule.id) - Number(a.rule.id);
      });

    if (valid.length === 0) {
      return null;
    }

    return {
      source: "bulk",
      scope: valid[0].rule.scope,
      percentage: Number(valid[0].rule.percentage),
      ruleId: valid[0].rule.id,
      minAmount: Number(valid[0].rule.min_amount)
    };
  }

  calculate({ unitPrice, amount, category, carryType, tier }) {
    const baseTotal = Number(unitPrice) * Number(amount);

    const scopeDiscount = this.resolveScopeDiscount({ category, carryType, tier, amount });
    const bulkDiscount = this.resolveBulkDiscount({ category, carryType, tier, amount });

    const scopePct = scopeDiscount ? Number(scopeDiscount.percentage) : 0;
    const bulkPct = bulkDiscount ? Number(bulkDiscount.percentage) : 0;

    // Policy selected: stacking only bulk + one scope discount. Never stack multiple scope discounts.
    const totalPct = Math.max(0, Math.min(95, scopePct + bulkPct));
    const discountTotal = Number(((baseTotal * totalPct) / 100).toFixed(2));
    const finalTotal = Number(Math.max(0, baseTotal - discountTotal).toFixed(2));

    return {
      baseTotal,
      finalTotal,
      discountTotal,
      totalPct,
      scopeDiscount,
      bulkDiscount
    };
  }
}

module.exports = DiscountEngine;
