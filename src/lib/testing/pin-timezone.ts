import { afterAll, beforeAll } from "vitest";

export function pinTimezone(timeZone: string) {
  let wasTz: string | undefined;
  beforeAll(() => {
    wasTz = process.env.TZ;
    process.env.TZ = timeZone;
  });
  afterAll(() => {
    // `process.env.TZ = undefined` stores the string "undefined", which is not a zone
    if (wasTz === undefined) delete process.env.TZ;
    else process.env.TZ = wasTz;
  });
}
