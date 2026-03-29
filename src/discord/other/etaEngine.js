class EtaEngine {
  constructor(db) {
    this.db = db;
  }

  getAverageDurationMs(carryType, tier) {
    const row = this.db
      .getConnection()
      .prepare(
        `SELECT AVG(completed_at - started_at) AS avg_duration
         FROM carries
         WHERE status = 'completed'
           AND carry_type = ?
           AND tier = ?
           AND completed_at IS NOT NULL
           AND started_at IS NOT NULL`
      )
      .get(carryType, tier);

    const avg = Number(row?.avg_duration || 0);
    if (Number.isFinite(avg) && avg > 0) {
      return avg;
    }

    return 20 * 60 * 1000;
  }

  getCarrierAvailabilityFactor(activeCarrierCount, onlineCarrierCount) {
    if (activeCarrierCount <= 0) return 1.8;
    if (onlineCarrierCount <= 0) return 1.5;
    return Math.max(0.55, 1 - onlineCarrierCount / (activeCarrierCount * 4));
  }

  getTimeOfDayFactor(now = new Date()) {
    const hour = now.getUTCHours();
    if (hour >= 16 && hour <= 22) return 0.9;
    if (hour >= 0 && hour <= 6) return 1.15;
    return 1;
  }

  estimate({ carryType, tier, queueDepth, activeCarrierCount, onlineCarrierCount, acceptanceRate = 0.8 }) {
    const avgDurationMs = this.getAverageDurationMs(carryType, tier);
    const carriers = Math.max(1, onlineCarrierCount || activeCarrierCount || 1);
    const availability = this.getCarrierAvailabilityFactor(activeCarrierCount || carriers, onlineCarrierCount || carriers);
    const timeOfDay = this.getTimeOfDayFactor(new Date());
    const acceptancePenalty = Math.max(0.8, 1 + (0.8 - Number(acceptanceRate || 0.8)));

    const baseMs = (Math.max(0, Number(queueDepth || 0)) + 1) * (avgDurationMs / carriers);
    const etaMs = Math.max(5 * 60 * 1000, Math.round(baseMs * availability * timeOfDay * acceptancePenalty));

    return {
      etaMs,
      avgDurationMs,
      factors: {
        availability,
        timeOfDay,
        acceptancePenalty,
        carriers
      }
    };
  }
}

module.exports = EtaEngine;
