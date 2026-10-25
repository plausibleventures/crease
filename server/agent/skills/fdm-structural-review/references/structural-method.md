# Structural method for FDM parts

## The practical answer

Load-bearing FDM parts can be calculated without always using 100% infill. Select one of four models and validate it at the required consequence level.

### 1. Explicit load-bearing walls; conservative infill

Use the actual printed wall thickness as the structural section and initially omit sparse infill from axial or bending capacity. This is often a useful conservative screen for boxes, brackets, and beams dominated by their perimeters.

Do not assume infill is irrelevant. It can carry shear, stabilize thin walls against buckling, distribute local loads, support top skins, and alter failure mode. Verify those functions separately.

In bending, material far from the neutral axis contributes disproportionately to the second moment of area. Increasing outer wall thickness can therefore be more mass-efficient than filling the neutral core. In uniform axial loading or through-thickness compression, internal material can contribute much more directly.

### 2. Calibrated effective material

Print a representative specimen with the same material, printer, nozzle, layer height, walls, gyroid or other infill, density, orientation, and thermal settings. Measure mass and dimensions, then obtain effective stiffness and relevant failure values in the service load direction. Use those values for a homogenized solid model only inside the tested range.

This is the most practical engineering method for repeated use of one stable print profile. Maintain separate profiles for materially different orientations, densities, patterns, temperatures, or conditioning states.

### 3. Unit-cell homogenization

Create a representative volume element (RVE) of the actual lattice, apply periodic boundary conditions, and compute an effective stiffness tensor. Calibrate the bead material and validate the RVE against printed coupons.

Research has demonstrated this for gyroid infill. Bean, Lopez-Anido, and Vel modeled gyroid cells with shell or solid elements and validated effective elastic properties against compression specimens. Their results also show why nominal infill is insufficient: nominal 75% single-bead gyroid specimens measured about 59% relative density, while double-bead specimens were much closer to 75%. Use their equations only within the paper's geometry and calibration context, not as universal slicer constants: <https://doi.org/10.3390/app12042180>.

### 4. Explicit lattice geometry

Mesh the actual walls and infill when local lattice buckling, wall-to-infill attachment, small cell counts, local load introduction, or spatially varying density matters. This is expensive and still requires process-calibrated bead/interface behavior.

## Gyroid at 15%

There is no universal modulus or strength for “gyroid 15%.” At minimum record:

- measured relative density or mass, not only the slicer setting;
- cell size and whether the toolpath resolves the intended wall thickness;
- wall/perimeter and top/bottom shell geometry;
- constituent as-printed bead and interlayer behavior;
- build direction and load direction;
- tension, compression, bending, shear, buckling, impact, or cyclic mode;
- specimen scale and number of unit cells across the loaded region.

For a one-off low-consequence part, calculate the explicit perimeter conservatively and treat 15% gyroid as stability/support material, then proof-test. For a repeated product family, print a small matrix of process-matched coupons and fit effective properties. For optimized lightweight structures, use RVE homogenization or explicit lattice FEM plus validation.

## What 100% infill changes

100% infill removes the need to model a sparse cellular core and often makes a continuum approximation easier. It does not remove raster direction, layer interfaces, incomplete welds, voids, dimensional variation, residual stress, or time/temperature dependence. Use as-printed directional coupon properties rather than raw-filament or injection-molded values.

Choose 100% infill when mass and print time are acceptable, the part is small, local load paths are complex, or a validated solid-profile workflow is valuable. Do not choose it merely to avoid defining loads and failure modes.

## Sizing loop

1. Define service and misuse loads, duration, cycles, environment, consequence, and acceptance criteria.
2. Orient the part so principal tensile load paths avoid relying on weak layer welds where practical.
3. Build the load path with explicit walls, ribs, webs, gussets, fillets, and local solid zones.
4. Calculate stress, strain, deflection, bearing, shear-out, buckling, and joint modes using the selected structural idealization.
5. Use a process- and direction-matched allowable with uncertainty and an explicit design factor.
6. Iterate wall thickness and geometry before increasing infill blindly.
7. Validate with coupons, interface specimens, and a service-relevant proof or lifecycle test.
