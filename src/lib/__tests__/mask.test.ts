import { maskHandleStrict } from "../maskText";
import { describe, expect, it } from "vitest";
import { maskHandle, maskMentions } from "../../components/mask";

describe("maskHandle", () => {
  it("shows 2+2 only from 8 characters", () => {
    expect(maskHandle("@jasmine42")).toBe("@ja***42");
    expect(maskHandle("@abcdefgh")).toBe("@ab***gh");
  });
  it("shows 1+1 for 5-7 character handles and never reveals 4 of 6", () => {
    expect(maskHandle("@jasmi")).toBe("@j***i");
    expect(maskHandle("@abcdef")).toBe("@a***f");
    expect(maskHandle("@abcde")).toBe("@a***e");
    expect(maskHandle("@abcdefg")).toBe("@a***g");
  });
  it("reveals nothing for short handles", () => {
    expect(maskHandle("@ab")).toBe("@***");
    expect(maskHandle("@abcd")).toBe("@***");
    expect(maskHandle("x")).toBe("@***");
  });
  it("splits by code point, not UTF-16 units", () => {
    expect(maskHandle("@😀😀😀😀😀😀😀😀")).toBe("@😀😀***😀😀");
    expect(maskHandle("@a😀cdef")).toBe("@a***f");
    expect(maskHandle("@😀😀😀😀😀")).toBe("@😀***😀");
    for (const h of ["@😀😀😀😀😀😀😀😀", "@a😀cdef", "@👨‍👩‍👧x"]) expect(maskHandle(h)).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});

describe("maskMentions", () => {
  it("masks @mentions inside comment bodies", () => {
    expect(maskMentions("@SomeoneElseReal you are wrong")).toBe("@So***al you are wrong");
    expect(maskMentions("hey @jasmine42, agree with @bob.smith_99.")).toBe("hey @ja***42, agree with @bo***99.");
  });
  it("leaves text without mentions alone, including lone @ and emails-ish bits", () => {
    expect(maskMentions("meet @ 5pm, price is $5")).toBe("meet @ 5pm, price is $5");
    expect(maskMentions("no handles here")).toBe("no handles here");
  });
  it("handles non-latin names", () => {
    expect(maskMentions("@テストユーザーです どうも")).toBe("@テス***です どうも");
  });
  it("masks full-width at-signs and one- or two-character mentions", () => {
    expect(maskMentions("hi ＠SomeoneElseReal you are wrong")).toBe("hi @So***al you are wrong");
    expect(maskMentions("@a and @bc are here")).toBe("@*** and @*** are here");
  });
  it("masks YouTube profile links, which identify a person just like a handle", () => {
    expect(maskMentions("go sub youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA now")).toBe("go sub youtube.com/*** now");
    expect(maskMentions("see https://www.youtube.com/@SomeoneReal123 ok")).toBe("see https://www.youtube.com/*** ok");
    expect(maskMentions("m.youtube.com/user/oldname and youtube.com/c/MyChannel")).toBe("m.youtube.com/*** and youtube.com/***");
    expect(maskMentions("youtu.be/c/abc")).toBe("youtu.be/***");
  });
  it("leaves ordinary video links alone", () => {
    expect(maskMentions("watch youtube.com/watch?v=abc123 and youtu.be/abc123")).toBe("watch youtube.com/watch?v=abc123 and youtu.be/abc123");
  });
});

it("strict demo names reveal only the first code point of names longer than one character", () => {
  for (const name of ["", "@", "j", "@j", "@😀"]) expect(maskHandleStrict(name)).toBe("@***");
  expect(maskHandleStrict("@jasmine42")).toBe("@j***");
  expect(maskHandleStrict("@😀hello")).toBe("@😀***");
});
