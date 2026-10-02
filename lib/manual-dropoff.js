'use strict';
// `<warehouseId>::<carrier>` combos where the warehouse crew hand-drops parcels
// at a local depot, so there is no on-demand carrier pickup to book. Sechelt
// (147654) staff drop Purolator parcels locally: Purolator answers 4100702
// "Pickup is not available at the requested location" for V0N 3A3. Their UPS
// pickup still books. Shared by the pipeline's pickup phase and the
// auto-rebooker, so neither keeps trying a pickup that cannot exist.
const MANUAL_DROPOFF_GROUPS = new Set([
  '147654::purolator',
]);

const groupKey = (warehouseId, carrierCode) => `${warehouseId}::${String(carrierCode || '').replace(/_walleted$/, '')}`;
const isManualDropoff = (warehouseId, carrierCode) => MANUAL_DROPOFF_GROUPS.has(groupKey(warehouseId, carrierCode));

module.exports = { MANUAL_DROPOFF_GROUPS, groupKey, isManualDropoff };
