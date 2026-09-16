"""
Guards the two properties the tablet actually cares about, both of which
AnimeGANv2 got wrong and cost us three days:

  * no normalisation op in the exported graph — onnxruntime-web's WebGPU
    backend silently returns a per-channel constant for the reshape-plus-
    InstanceNormalization pattern that torch emits for GroupNorm;
  * no size baked into the graph — one file has to serve every frame size.

Run: python3 train/student_check.py   (or via npm test, which skips it when
torch is not installed, as on CI).
"""

import sys
import tempfile

try:
    import numpy as np
    import onnx
    import onnxruntime as ort
    import torch  # noqa: F401
except ImportError as e:
    print(f'student_check skipped: {e.name} not installed')
    sys.exit(0)

from student import Student, export

NORMS = {'InstanceNormalization', 'GroupNormalization', 'BatchNormalization', 'LpNormalization'}

path = tempfile.NamedTemporaryFile(suffix='.onnx', delete=False).name
export(Student(width=8, blocks=2), path, size=64)

ops = {n.op_type for n in onnx.load(path).graph.node}
assert not ops & NORMS, f'normalisation op in the graph: {sorted(ops & NORMS)}'

s = ort.InferenceSession(path, providers=['CPUExecutionProvider'])
i, o = s.get_inputs()[0], s.get_outputs()[0]
assert i.shape[2:] == ['h', 'w'], f'input size is baked in: {i.shape}'

# Two sizes from one file, and neither one is the size it was exported at.
for px, py in ((96, 96), (128, 64)):
    y = s.run([o.name], {i.name: np.random.uniform(-1, 1, (1, 3, py, px)).astype(np.float32)})[0]
    assert y.shape == (1, 3, py, px), f'{px}x{py} in, {y.shape} out'
    assert -1 <= y.min() and y.max() <= 1, f'tanh range broken: {y.min()}…{y.max()}'

print(f'student checks passed ({sorted(ops)})')
