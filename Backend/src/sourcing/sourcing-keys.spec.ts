import { maskVin, sourcingPartKey, sourcingVehicleKey } from './sourcing-keys';

describe('sourcingPartKey', () => {
  it('matches the same part across wording and language', () => {
    expect(sourcingPartKey('Фильтр')).toBe(sourcingPartKey('filter'));
    expect(sourcingPartKey('tormoz kolodka')).toBe(sourcingPartKey('kolodka tormoz'));
  });
  it('keeps different parts apart', () => {
    expect(sourcingPartKey('фильтр')).not.toBe(sourcingPartKey('радиатор'));
  });
});

describe('sourcingVehicleKey', () => {
  const none = { vehicleId: null, brand: null, model: null, year: null };
  it('keeps different cars apart', () => {
    expect(sourcingVehicleKey({ ...none, vehicleId: 'v1' })).not.toBe(
      sourcingVehicleKey({ ...none, vehicleId: 'v2' }),
    );
    expect(sourcingVehicleKey({ ...none, brand: 'Kia', model: 'K5' })).not.toBe(
      sourcingVehicleKey({ ...none, brand: 'Kia', model: 'K8' }),
    );
  });
  it('an unspecified car is not the same as a named one', () => {
    expect(sourcingVehicleKey(none)).toBe('none');
    expect(sourcingVehicleKey({ ...none, brand: 'Kia' })).not.toBe('none');
  });
});

describe('maskVin', () => {
  it('hides the serial number', () => {
    expect(maskVin('XUFCB6950K0000017')).toBe('XUFCB6950K0******');
  });
  it('hides anything too short to split', () => {
    expect(maskVin('ABC123')).toBe('******');
  });
});
