// Original small examples for renderer tests; not executable AI kernels.
export const CODE_SAMPLES={
  python:'import torch\n@torch.no_grad()\ndef infer(x: torch.Tensor):\n\treturn torch.softmax(x.float(), dim=-1)\n',
  tilelang:'import tilelang.language as T\n@T.prim_func\ndef add(A: T.Tensor((128,), "float32")):\n    with T.Kernel(1, threads=128):\n        tmp = T.alloc_shared((128,), "float32")\n        T.copy(A, tmp)\n',
  triton:'import triton.language as tl\n@triton.jit\ndef add(x, BLOCK: tl.constexpr):\n    i = tl.program_id(0) * BLOCK + tl.arange(0, BLOCK)\n    tl.store(x + i, tl.load(x + i) + 1.0)\n',
  hip:'#include <hip/hip_runtime.h>\n__global__ void add(float* x) {\n    int i = blockIdx.x * blockDim.x + threadIdx.x;\n    x[i] += 1.0f;\n}\n',
  cuda:'__global__ void add(float* x) { __syncthreads(); }\nadd<<<grid, block>>>(x);\n',
  cpp:'#include <vector>\ntemplate<class T> T sum(const std::vector<T>& xs) { return xs[0]; }\n',
  powershell:'$env:HIP_VISIBLE_DEVICES = "0"\nGet-ChildItem -Path . | Where-Object { $_.Length -gt 1024 }\n',
  bash:'#!/usr/bin/env bash\nexport HIP_VISIBLE_DEVICES=0\npython train.py \\\n  --model "$MODEL" # run\n',
  dockerfile:'FROM python:3.12\nARG ROCM_VERSION=6\nRUN python -m pip install torch\n',
  cmake:'cmake_minimum_required(VERSION 3.24)\nproject(Inference LANGUAGES CXX HIP)\nadd_executable(infer main.cpp)\n',
  llvm:'define float @add(float %a, float %b) {\n  %sum = fadd float %a, %b\n  ret float %sum\n}\n',
};
