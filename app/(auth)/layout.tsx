import Image from "next/image";

export default function RootLayout({
    children,
  }: Readonly<{
    children: React.ReactNode;
  }>) {
    return (
      <main className="flex min-h-screen w-full justify-between font-inter">
          {children}
          <div className="auth-asset">
            <div>
            <Image 
  src="/icons/auth-image.svg" 
  alt="Auth Image" 
  width={200}  // Set width as a base size
  height={100} // Set height as a base size
  layout="responsive" // Make the image responsive to the container
/>
            </div>
          </div>
      </main>
    );
  }
  