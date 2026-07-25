export * as THREE from 'three';

import { AppBridge } from '@/app';

export * from '@/camera';
export * from '@/controls';
export * from '@/trees';
export * from '@/lights';
export * from '@/sky';
export * from '@/renderer';
export * from '@/audio';

// Objects
export * from '@/objects/aimPoint';
export * from '@/objects/ballTrail';
export * from '@/objects/flagStick';
export * from '@/objects/ghostBall';
export * from '@/objects/golfBall';

// Shaders
export * from '@/shaders';

// Courses
export * from '@/courses/game';
export * from '@/courses/loader';
export * from '@/courses/surfaces';
export * from '@/courses/player';

// Physics
export * from '@/physics/ballPhysics';
export * from '@/physics/groundPhysics';

// UI
export * from '@/ui';

// Utils
export * from '@/utils/units';
export * from '@/utils/data';

// Networking (multiplayer)
export * from '@/net/client';
export * from '@/net/gameSync';
export * from '@/net/types';

import '@/css/base.css';

export const app = new AppBridge();