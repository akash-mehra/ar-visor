"""
The stylizer we train ourselves, and the script that exports it to ONNX.

Shaped by two things AnimeGANv2 taught us the hard way on the tablet:

  * No normalisation layers. Torch exports GroupNorm(1, C) as a reshape to
    (1, 1, H*W*C) feeding InstanceNormalization, and onnxruntime-web's WebGPU
    backend returns a per-channel constant for that — silently, as a
    well-formed tensor. Distillation is supervised, so there is no adversarial
    instability here that normalisation would be buying us.
  * Fully convolutional with no baked-in size. AnimeGANv2's reshape constants
    pin it to 512x512, which is why it cannot be run cheaper. Train at 128,
    infer at whatever the hand-held frame gives us.

That leaves Conv, LeakyRelu, Add, Resize and Tanh — five ops, all of them
boring, none of them the kind a provider gets wrong.
"""

import argparse

import torch
import torch.nn as nn
import torch.nn.functional as F

SLOPE = 0.2


class Residual(nn.Module):
    def __init__(self, c: int):
        super().__init__()
        self.a = nn.Conv2d(c, c, 3, padding=1)
        self.b = nn.Conv2d(c, c, 3, padding=1)

    def forward(self, x):
        return x + self.b(F.leaky_relu(self.a(x), SLOPE))


class Student(nn.Module):
    """Johnson-style feedforward stylizer: downsample, transform, upsample."""

    def __init__(self, width: int = 16, blocks: int = 4):
        super().__init__()
        c1, c2, c3 = width, width * 2, width * 4
        self.head = nn.Conv2d(3, c1, 7, padding=3)
        self.down1 = nn.Conv2d(c1, c2, 3, stride=2, padding=1)
        self.down2 = nn.Conv2d(c2, c3, 3, stride=2, padding=1)
        self.body = nn.Sequential(*[Residual(c3) for _ in range(blocks)])
        self.up1 = nn.Conv2d(c3, c2, 3, padding=1)
        self.up2 = nn.Conv2d(c2, c1, 3, padding=1)
        self.tail = nn.Conv2d(c1, 3, 7, padding=3)

    def forward(self, x):
        x = F.leaky_relu(self.head(x), SLOPE)
        x = F.leaky_relu(self.down1(x), SLOPE)
        x = F.leaky_relu(self.down2(x), SLOPE)
        x = self.body(x)
        # Nearest + conv rather than transposed conv: same cost, no
        # checkerboarding, and it exports to Resize with scales rather than
        # sizes, which keeps the graph free of the input's dimensions.
        x = F.interpolate(x, scale_factor=2.0, mode='nearest')
        x = F.leaky_relu(self.up1(x), SLOPE)
        x = F.interpolate(x, scale_factor=2.0, mode='nearest')
        x = F.leaky_relu(self.up2(x), SLOPE)
        return torch.tanh(self.tail(x))


def export(model: nn.Module, path: str, size: int = 256) -> None:
    """Export with H and W free, so one file serves every frame size."""
    model.eval()
    torch.onnx.export(
        model,
        torch.randn(1, 3, size, size),
        path,
        input_names=['input_image'],
        output_names=['output_image'],
        dynamic_axes={'input_image': {2: 'h', 3: 'w'}, 'output_image': {2: 'h', 3: 'w'}},
        opset_version=13,
        dynamo=False
    )


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--width', type=int, default=16)
    p.add_argument('--blocks', type=int, default=4)
    p.add_argument('--out', default='student.onnx')
    a = p.parse_args()
    m = Student(a.width, a.blocks)
    export(m, a.out)
    n = sum(t.numel() for t in m.parameters())
    print(f'{a.out}: width {a.width}, {a.blocks} blocks, {n / 1000:.0f}k params')
