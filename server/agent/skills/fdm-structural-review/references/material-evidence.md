# Material evidence

## Evidence hierarchy

From weakest to strongest for a specific printed part:

1. Polymer-family or generic internet value — useful only for rough scale and material comparison.
2. Filament manufacturer datasheet — identifies feedstock or a vendor test, often without matching printer and orientation.
3. Published printed-specimen data — useful when material and process variables are sufficiently similar.
4. Same-machine, same-profile directional coupon — supports calibrated screening for that process window.
5. Feature or interface coupon — captures snap roots, holes, inserts, weld lines, walls plus infill, or other local failure modes.
6. Full-part or assembly test — validates the actual load path and interfaces under stated conditions.
7. Qualified production process with sampling and acceptance criteria — required when production variation matters.

ASTM F3489 lists material choice, anisotropy, storage and preparation, porosity, build orientation and location, environment, gripping, speed, and temperature among factors that affect reported static properties. ISO/ASTM 52924 provides a framework for specifying achievable part-property classes. Keep paid standard text out of the skill; record the exact standard and edition used by the project.

## Required profile shape

Use this as a starting JSON shape (checklist) for the material profile. [Crease: upstream fed it to `validate_material_profile.py`, not vendored.]

```json
{
  "schema_version": "0.1",
  "material": {
    "manufacturer": "...",
    "product": "...",
    "polymer_family": "PETG",
    "lot": "optional"
  },
  "machine": { "model": "..." },
  "process": {
    "nozzle_diameter_mm": 0.4,
    "nozzle_temperature_c": 245,
    "bed_temperature_c": 80,
    "layer_height_mm": 0.2,
    "line_width_mm": 0.45,
    "wall_count": 4,
    "build_orientation": "named part axes relative to XYZ build axes",
    "infill": { "pattern": "gyroid", "nominal_percent": 15 }
  },
  "conditioning": {
    "drying": "...",
    "test_temperature_c": 23,
    "humidity": "..."
  },
  "service": {
    "load_cases": ["..."],
    "temperature_c": "range or value",
    "duration": "...",
    "cycles": 1
  },
  "property_evidence": [
    {
      "evidence_type": "datasheet|published|coupon|part-test",
      "source": "...",
      "property": "elastic_modulus_x",
      "value": 0,
      "units": "MPa",
      "specimen_orientation": "...",
      "process_match": false,
      "test_method": "..."
    }
  ]
}
```

Record measured mass and relative density for sparse infill coupons. A slicer's nominal infill percentage is a process instruction, not a verified material property.

## Test selection

- Use tension or flexure for directional stiffness and static strength as appropriate to the service mode.
- Use compression for cellular-core crushing or buckling.
- Use bearing, pullout, or feature coupons for pins, screws, and inserts.
- Use dwell tests for permanent snap deflection and preload relaxation.
- Use cycle tests with service-relevant displacement, mean load, temperature, and acceptance criteria.
- Use environmental conditioning when moisture or temperature changes service behavior.
