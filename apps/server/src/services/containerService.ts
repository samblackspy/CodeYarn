// src/services/containerService.ts
import prisma from '@codeyarn/db';
 
export async function findFullContainerId(partialId: string): Promise<string | null> {
    try {
        if (partialId.length > 12) { // Assuming Docker short IDs are 12 chars
            // Check if it's potentially a full ID already present
            const exactMatch = await prisma.container.findUnique({
                 where: { id: partialId },
                 select: { id: true }
            });
            if (exactMatch) return exactMatch.id;
        }

        // Find container by prefix
        const allContainers = await prisma.container.findMany({ select: { id: true } });
        const containerRecord = allContainers.find((c: { id: string }) => c.id.startsWith(partialId));

        if (containerRecord) {
            return containerRecord.id;
        }
        // Fallback: check if the partialId is already a full one but not in DB (less likely)
        // This part might be redundant if all known containers are in the DB.
        // For now, if it's longer than 12 and not found by prefix, it could be a direct full ID.
        // However, relying on DB records is safer.
        if (partialId.length > 12) {
             console.warn(`[ContainerService] Partial ID ${partialId} looks like a full ID but not found in DB via prefix search.`);
             // We could try to query docker directly here if necessary, but for now, stick to DB.
        }


        return null;
    } catch (error) {
        console.error(`[API Internal] Error finding full container ID for ${partialId}:`, error);
        return null;
    }
}