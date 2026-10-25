# First-order models

Use N, mm, and MPa (`1 MPa = 1 N/mm²`) unless the task explicitly establishes another coherent unit system. Preserve load signs where useful, but compare failure quantities by magnitude.

## Load path and equilibrium

Start from the isolated body and solve `ΣF = 0` and `ΣM = 0`. Include reactions, eccentricity, connector forces, gravity, cable pulls, thermal restraint, assembly loads, impact assumptions, and all service cases. Do not continue when the supports or load path are ambiguous.

## Axial loading

For a prismatic homogeneous member under centered axial load:

- average stress: `σ = F/A`;
- strain in a linear elastic material: `ε = σ/E`;
- elongation: `δ = FL/(AE)`.

Do not use the average stress as a local hole, thread, notch, bearing, or load-introduction stress.

## Rectangular cantilever

For a prismatic slender beam with an ideal fixed end, small deflection, and an end force:

- `I = b h³/12`;
- root stress: `σ = 6FL/(b h²)`;
- tip deflection: `δ = FL³/(3EI) = 4FL³/(Ebh³)`;
- prescribed-deflection force: `F = 3EIδ/L³`;
- screening root strain: `ε ≈ 1.5 hδ/L²`.

Here `h` is the dimension along the bending direction. Treat `L/h < 10` as a warning that shear deformation, root geometry, and three-dimensional stress may dominate; it is a screening heuristic, not a universal boundary. Escalate large rotations, curved or tapered arms, contact-driven insertion, or snap-through to nonlinear analysis and physical testing.

## Circular-shaft torsion

For a homogeneous circular shaft:

- `J = πd⁴/32`;
- surface shear stress: `τmax = 16T/(πd³)`;
- twist: `θ = TL/(GJ)`.

Reject this model for non-circular, open, thin-walled, or warping-sensitive sections.

## Euler buckling

For an ideal straight slender column with centered axial load and known end factor `K`:

- `Pcr = π²EI/(KL)²`.

Label the result as an ideal eigenvalue screening. Initial curvature, eccentricity, local wall buckling, material nonlinearity, creep, and connection flexibility reduce real capacity.

## Thermal bar

For uniform temperature change and constant properties:

- free expansion: `ΔL = αLΔT`;
- perfectly restrained linear-elastic stress: `σ = -EαΔT`.

Escalate temperature gradients, relaxation, temperature-dependent properties, and operation near a polymer transition range.

## Pins and joined sections

Use average single-shear stress `τ = F/A` and bearing stress `σb = F/(td)` only as separate screening modes. Also check net section, shear-out, pullout, boss cracking, preload, slip, separation, torque scatter, and long-term relaxation.

## Failure criteria

- Use von Mises or Tresca only for a defensible isotropic ductile-yield model.
- Use principal stress or strain criteria only with appropriate brittle allowables.
- Require directional tensile, compressive, and shear data plus material axes for orthotropic criteria.
- Treat fatigue, creep, fracture, wear, and impact as separate models requiring matching evidence.
