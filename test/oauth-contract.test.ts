import { describe, expect, it } from "vitest"
import {
  USER_CODE_ALPHABET,
  decodeDeviceCodeResponse,
  isValidUserCode,
} from "../src/contracts/oauth.js"
import { parseDeviceState } from "../src/storage/schemas.js"
import { validDeviceState } from "./helpers.js"

const ISSUER = "https://api.adrate.io"

function deviceResponse(userCode: string): string {
  return JSON.stringify({
    device_code: "A".repeat(43),
    user_code: userCode,
    verification_uri: "https://app.adrate.io/cli/authorize",
    verification_uri_complete: `https://app.adrate.io/cli/authorize?user_code=${userCode}`,
    expires_in: 600,
    interval: 5,
  })
}

describe("Device user_code contract", () => {
  it("freezes the exact T02 unambiguous alphabet", () => {
    expect(USER_CODE_ALPHABET).toBe("ABCDEFGHJKMNPQRSTUVWXYZ23456789")
    expect(isValidUserCode("ABCD-EFGH")).toBe(true)
    expect(
      decodeDeviceCodeResponse(deviceResponse("ABCD-EFGH"), ISSUER)
    ).not.toBeNull()
    expect(parseDeviceState(validDeviceState())).not.toBeNull()
  })

  it.each(["I", "L", "O", "0", "1"])(
    "rejects ambiguous character %s in both remote and persisted state",
    (ambiguous) => {
      const userCode = `${ambiguous}BCD-EFGH`
      expect(isValidUserCode(userCode)).toBe(false)
      expect(
        decodeDeviceCodeResponse(deviceResponse(userCode), ISSUER)
      ).toBeNull()
      expect(
        parseDeviceState(
          validDeviceState({
            userCode,
            verificationUriComplete: `https://app.adrate.io/cli/authorize?user_code=${userCode}`,
          })
        )
      ).toBeNull()
    }
  )

  it.each(["abcd-EFGH", "ABCD_EFGH", "ABCD--EFGH", "ABCD-EFG", "ABCD-EFGH "])(
    "rejects non-canonical format %j",
    (userCode) => {
      expect(isValidUserCode(userCode)).toBe(false)
    }
  )
})
