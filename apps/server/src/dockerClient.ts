// src/dockerClient.ts
import Docker from 'dockerode';
import express, { Router, Request, Response, NextFunction } from 'express';

export const docker = new Docker();

